import { randomUUID } from 'node:crypto';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  SEAT_STATUS,
  type SeatChange,
  type SeatStatus,
} from '@app/shared';
import { ConflictException, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { bookings } from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { watchSeatChanges } from '../../testing/seat-changes.js';
import { SPEC_NOW } from '../../testing/time.js';
import { RedisSeatChangePublisher } from './adapters/redis-seat-changes.js';
import type { BookingsService } from './bookings.service.js';
import type { PaymentProvider } from './domain/payment-provider.js';
import type { SeatChangePublisher } from './domain/seat-change.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { ACTIVE_BOOKING_STATUSES, seatStatusOf } from './domain/seat-status.js';
import { createBookingsService } from './testing/create-bookings-service.js';

const clock = { now: () => SPEC_NOW };

describe('seat changes published after the booking commits', () => {
  const database = openTestDatabase();
  const { db } = database;
  let redis: Redis;
  let paymentSucceeds = true;
  const payments: PaymentProvider = {
    charge: () => Promise.resolve({ succeeded: paymentSucceeds }),
  };
  /** What a viewer who reads the database at the moment of the message would see for that seat. */
  const visibleWhenPublished: { change: SeatChange; visible: SeatStatus }[] = [];
  let publish: SeatChangePublisher['publish'];
  let service: BookingsService;

  beforeAll(async () => {
    redis = await openTestRedis();
    const redisPublisher = new RedisSeatChangePublisher(redis);
    // Reads over another connection than the booking transaction's: an uncommitted change is
    // invisible to it.
    const publisher: SeatChangePublisher = {
      publish: async (change) => {
        const active = await db
          .select({ status: bookings.status })
          .from(bookings)
          .where(
            and(
              eq(bookings.seatId, change.seatId),
              inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES])
            )
          )
          .orderBy(bookings.status);
        visibleWhenPublished.push({ change, visible: seatStatusOf(active.at(-1)?.status ?? null) });
        await publish(change);
      },
    };
    publish = (change) => redisPublisher.publish(change);
    service = createBookingsService(db, redis, clock, payments, publisher);
  });
  afterAll(async () => {
    await redis.quit();
    await database.close();
  });
  afterEach(() => {
    paymentSucceeds = true;
    publish = (change) => new RedisSeatChangePublisher(redis).publish(change);
    vi.restoreAllMocks();
  });

  async function watchedSeat() {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const watch = await watchSeatChanges(redis, eventId);
    return { eventId, seatId: seatIds[0] ?? '', userId: randomUUID(), watch };
  }

  async function held(seat: { eventId: string; seatId: string; userId: string }) {
    const result = await service.hold(seat);
    if (result.outcome !== HOLD_OUTCOME.PLACED) throw new Error('hold was not placed');
    return result.bookingId;
  }

  it('hold publishes HELD, after the hold is stored', async () => {
    const seat = await watchedSeat();

    await held(seat);
    await seat.watch.settle();

    expect(seat.watch.changes).toEqual([
      {
        eventId: seat.eventId,
        seatId: seat.seatId,
        status: SEAT_STATUS.HELD,
        at: SPEC_NOW.toISOString(),
      },
    ]);
    expect(visibleWhenPublished.at(-1)).toMatchObject({ visible: SEAT_STATUS.HELD });
    await seat.watch.stop();
  });

  it('a hold that finds the seat taken publishes nothing', async () => {
    const seat = await watchedSeat();
    await held(seat);
    await seat.watch.settle();
    const before = seat.watch.changes.length;

    const second = await service.hold({ ...seat, userId: randomUUID() });
    await seat.watch.settle();

    expect(second.outcome).not.toBe(HOLD_OUTCOME.PLACED);
    expect(seat.watch.changes).toHaveLength(before);
    await seat.watch.stop();
  });

  it('a successful payment publishes one SOLD, not the PAID step, after the commit', async () => {
    const seat = await watchedSeat();
    const bookingId = await held(seat);

    await service.pay({ bookingId, userId: seat.userId, idempotencyKey: randomUUID() });
    await seat.watch.settle();

    expect(seat.watch.changes.map(({ status }) => status)).toEqual([
      SEAT_STATUS.HELD,
      SEAT_STATUS.SOLD,
    ]);
    expect(visibleWhenPublished.at(-1)).toMatchObject({ visible: SEAT_STATUS.SOLD });
    await seat.watch.stop();
  });

  it('a failed payment releases the seat: AVAILABLE', async () => {
    const seat = await watchedSeat();
    const bookingId = await held(seat);
    paymentSucceeds = false;

    await service.pay({ bookingId, userId: seat.userId, idempotencyKey: randomUUID() });
    await seat.watch.settle();

    expect(seat.watch.changes.map(({ status }) => status)).toEqual([
      SEAT_STATUS.HELD,
      SEAT_STATUS.AVAILABLE,
    ]);
    expect(visibleWhenPublished.at(-1)).toMatchObject({ visible: SEAT_STATUS.AVAILABLE });
    await seat.watch.stop();
  });

  it('the same payment key again changes nothing and publishes nothing', async () => {
    const seat = await watchedSeat();
    const bookingId = await held(seat);
    const idempotencyKey = randomUUID();
    await service.pay({ bookingId, userId: seat.userId, idempotencyKey });
    await seat.watch.settle();
    const before = seat.watch.changes.length;

    await service.pay({ bookingId, userId: seat.userId, idempotencyKey });
    await seat.watch.settle();

    expect(seat.watch.changes).toHaveLength(before);
    await seat.watch.stop();
  });

  it('a payment the state machine refuses publishes nothing', async () => {
    const seat = await watchedSeat();
    const bookingId = await held(seat);
    await service.cancel({ bookingId, userId: seat.userId });
    await seat.watch.settle();
    const before = seat.watch.changes.length;

    await expect(
      service.pay({ bookingId, userId: seat.userId, idempotencyKey: randomUUID() })
    ).rejects.toBeInstanceOf(ConflictException);
    await seat.watch.settle();

    expect(seat.watch.changes).toHaveLength(before);
    await seat.watch.stop();
  });

  it('cancel publishes AVAILABLE, after the commit', async () => {
    const seat = await watchedSeat();
    const bookingId = await held(seat);

    await service.cancel({ bookingId, userId: seat.userId });
    await seat.watch.settle();

    expect(seat.watch.changes.map(({ status }) => status)).toEqual([
      SEAT_STATUS.HELD,
      SEAT_STATUS.AVAILABLE,
    ]);
    expect(visibleWhenPublished.at(-1)).toMatchObject({ visible: SEAT_STATUS.AVAILABLE });
    await seat.watch.stop();
  });

  describe('NAIVE seat with several active bookings', () => {
    async function twoHolds() {
      const { eventId, seatIds } = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.NAIVE,
        seats: 1,
      });
      const seat = { eventId, seatId: seatIds[0] ?? '' };
      const watch = await watchSeatChanges(redis, eventId);
      const [a, b] = [randomUUID(), randomUUID()];
      const bookingA = await held({ ...seat, userId: a });
      // NAIVE refuses a second hold only after it read the first; a race leaves two active
      // bookings, which this row stands for.
      const [second] = await db
        .insert(bookings)
        .values({
          ...seat,
          userId: b,
          strategy: BOOKING_STRATEGY.NAIVE,
          status: BOOKING_STATUS.HELD,
          holdExpiresAt: new Date(SPEC_NOW.getTime() + 60_000),
        })
        .returning({ id: bookings.id });
      const bookingB = second?.id ?? '';
      return { watch, a, b, bookingA, bookingB };
    }

    it('cancelling one of two holds publishes HELD, the seat is still occupied', async () => {
      const { watch, a, bookingA } = await twoHolds();

      await service.cancel({ bookingId: bookingA, userId: a });
      await watch.settle();

      expect(watch.changes.map(({ status }) => status)).toEqual([
        SEAT_STATUS.HELD,
        SEAT_STATUS.HELD,
      ]);
      await watch.stop();
    });

    it('cancelling a hold of a seat that another user has bought publishes SOLD', async () => {
      const { watch, a, b, bookingA, bookingB } = await twoHolds();
      await service.pay({ bookingId: bookingB, userId: b, idempotencyKey: randomUUID() });

      await service.cancel({ bookingId: bookingA, userId: a });
      await watch.settle();

      expect(watch.changes.map(({ status }) => status)).toEqual([
        SEAT_STATUS.HELD,
        SEAT_STATUS.SOLD,
        SEAT_STATUS.SOLD,
      ]);
      await watch.stop();
    });
  });

  it('a publisher that throws neither fails the hold nor stays silent', async () => {
    const seat = await watchedSeat();
    publish = () => Promise.reject(new Error('redis down'));
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const bookingId = await held(seat);

    expect(logged).toHaveBeenCalledWith(expect.stringContaining(bookingId));
    const [stored] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(stored?.userId).toBe(seat.userId);
    await seat.watch.stop();
  });
});
