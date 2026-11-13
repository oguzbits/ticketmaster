import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { BOOKING_STATUS, BOOKING_STRATEGY, TRANSITION_REASON } from '@app/shared';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';
import { bookings, bookingTransitions } from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import type { BookingsService } from './bookings.service.js';
import type { PaymentProvider } from './domain/payment-provider.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';

const NOW = SPEC_NOW;
const SEAT_PRICE_CENTS = 1000;
const PARALLEL_CHARGE_MS = 200;
// The key column is unique over the whole table, so every run needs fresh keys.
const RUN_ID = randomUUID();
const key = (name: string): string => `${RUN_ID}-${name}`;

class RecordingProvider implements PaymentProvider {
  readonly calls: Parameters<PaymentProvider['charge']>[0][] = [];
  succeed = true;
  chargeDelayMs = 0;
  async charge(input: Parameters<PaymentProvider['charge']>[0]): Promise<{ succeeded: boolean }> {
    this.calls.push(input);
    await delay(this.chargeDelayMs);
    return { succeeded: this.succeed };
  }
}

describe('payment and cancel', () => {
  const database = openTestDatabase();
  const { db } = database;
  const env = loadEnv();
  const provider = new RecordingProvider();
  let now = NOW;
  let redis: Redis;
  let service: BookingsService;

  beforeAll(async () => {
    redis = await openTestRedis();
    service = createBookingsService(db, redis, { now: () => now }, provider);
  });
  afterAll(async () => {
    await redis.quit();
    await database.close();
  });

  async function heldBooking(): Promise<{
    bookingId: string;
    userId: string;
    eventId: string;
    seatId: string;
  }> {
    now = NOW;
    provider.calls.length = 0;
    provider.succeed = true;
    provider.chargeDelayMs = 0;
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');
    const userId = randomUUID();
    const result = await service.hold({ eventId, seatId, userId });
    if (result.outcome !== HOLD_OUTCOME.PLACED) throw new Error('hold was not placed');
    return { bookingId: result.bookingId, userId, eventId, seatId };
  }

  async function transitionsOf(bookingId: string): Promise<string[]> {
    const rows = await db
      .select()
      .from(bookingTransitions)
      .where(eq(bookingTransitions.bookingId, bookingId));
    return rows.map((row) => `${row.fromStatus}>${row.toStatus}`).sort();
  }

  it('pays a held booking and confirms it with HELD→PAID→CONFIRMED transitions', async () => {
    const { bookingId, userId } = await heldBooking();

    const view = await service.pay({ bookingId, userId, idempotencyKey: key('1') });

    expect(view.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toEqual([
      { bookingId, amountCents: SEAT_PRICE_CENTS, idempotencyKey: key('1') },
    ]);
    expect(await transitionsOf(bookingId)).toEqual(
      [
        `null>${BOOKING_STATUS.HELD}`,
        `${BOOKING_STATUS.HELD}>${BOOKING_STATUS.PAID}`,
        `${BOOKING_STATUS.PAID}>${BOOKING_STATUS.CONFIRMED}`,
      ].sort()
    );
  });

  it('a failed charge cancels with PAYMENT_FAILED', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.succeed = false;

    const view = await service.pay({ bookingId, userId, idempotencyKey: key('2') });

    expect(view.status).toBe(BOOKING_STATUS.CANCELLED);
    const [record] = await db
      .select()
      .from(bookingTransitions)
      .where(
        and(
          eq(bookingTransitions.bookingId, bookingId),
          eq(bookingTransitions.toStatus, BOOKING_STATUS.CANCELLED)
        )
      );
    expect(record).toMatchObject({
      fromStatus: BOOKING_STATUS.HELD,
      reason: TRANSITION_REASON.PAYMENT_FAILED,
      actorId: userId,
    });
  });

  it('a key another booking already used is a conflict and is not charged', async () => {
    const first = await heldBooking();
    await service.pay({ ...first, idempotencyKey: key('shared') });
    const second = await heldBooking();

    await expect(service.pay({ ...second, idempotencyKey: key('shared') })).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(provider.calls).toHaveLength(0);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, second.bookingId));
    expect(row?.status).toBe(BOOKING_STATUS.HELD);
  });

  it('two parallel payments with one key charge once and confirm once', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('parallel');
    // A slow charge keeps the first payment open, so the second one overlaps with it.
    provider.chargeDelayMs = PARALLEL_CHARGE_MS;

    const views = await Promise.all([
      service.pay({ bookingId, userId, idempotencyKey }),
      service.pay({ bookingId, userId, idempotencyKey }),
    ]);

    expect(views.map((view) => view.status)).toEqual([
      BOOKING_STATUS.CONFIRMED,
      BOOKING_STATUS.CONFIRMED,
    ]);
    expect(provider.calls).toHaveLength(1);
    expect(await transitionsOf(bookingId)).toHaveLength(3);
  });

  it('the same key after a failed charge returns CANCELLED and does not charge again', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.succeed = false;
    await service.pay({ bookingId, userId, idempotencyKey: key('3') });
    provider.succeed = true;

    const again = await service.pay({ bookingId, userId, idempotencyKey: key('3') });

    expect(again.status).toBe(BOOKING_STATUS.CANCELLED);
    expect(provider.calls).toHaveLength(1);
  });

  it('the same key after success returns CONFIRMED without a second charge', async () => {
    const { bookingId, userId } = await heldBooking();
    await service.pay({ bookingId, userId, idempotencyKey: key('4') });

    const again = await service.pay({ bookingId, userId, idempotencyKey: key('4') });

    expect(again.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toHaveLength(1);
  });

  it('another key on a confirmed booking is a conflict', async () => {
    const { bookingId, userId } = await heldBooking();
    await service.pay({ bookingId, userId, idempotencyKey: key('5') });

    await expect(
      service.pay({ bookingId, userId, idempotencyKey: key('6') })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(provider.calls).toHaveLength(1);
  });

  it('a hold past its expiry is a conflict and is not charged', async () => {
    const { bookingId, userId } = await heldBooking();
    now = new Date(NOW.getTime() + (env.HOLD_TTL_SECONDS + 1) * 1000);

    await expect(
      service.pay({ bookingId, userId, idempotencyKey: key('7') })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(provider.calls).toHaveLength(0);
  });

  it("another user's booking is forbidden, an unknown one not found", async () => {
    const { bookingId } = await heldBooking();

    await expect(
      service.pay({ bookingId, userId: randomUUID(), idempotencyKey: key('8') })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.cancel({ bookingId, userId: randomUUID() })).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(
      service.pay({ bookingId: randomUUID(), userId: randomUUID(), idempotencyKey: key('9') })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(provider.calls).toHaveLength(0);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row?.status).toBe(BOOKING_STATUS.HELD);
  });

  it('cancel of a confirmed booking frees the seat', async () => {
    const { bookingId, userId, eventId, seatId } = await heldBooking();
    await service.pay({ bookingId, userId, idempotencyKey: key('10') });

    const view = await service.cancel({ bookingId, userId });
    const next = await service.hold({ eventId, seatId, userId: randomUUID() });

    expect(view.status).toBe(BOOKING_STATUS.CANCELLED);
    expect(next.outcome).toBe(HOLD_OUTCOME.PLACED);
  });

  it('cancel of a booking that cannot be cancelled is a conflict', async () => {
    const { bookingId, userId } = await heldBooking();
    await service.cancel({ bookingId, userId });

    await expect(service.cancel({ bookingId, userId })).rejects.toBeInstanceOf(ConflictException);
  });
});
