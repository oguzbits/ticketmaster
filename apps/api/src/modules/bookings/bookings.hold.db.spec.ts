import { randomUUID } from 'node:crypto';

import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  TRANSITION_REASON,
} from '@app/shared';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';
import type { Clock } from '../../core/clock.js';
import { bookings, bookingTransitions } from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import { AuditService } from '../audit/index.js';
import { auditRows } from '../audit/testing/index.js';
import { SeatReservations } from './adapters/seat-reservations.js';
import type { BookingsService } from './bookings.service.js';
import { HOLD_OUTCOME, type HoldResult } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';
import { RecordingMetrics } from './testing/recording-metrics.js';

const NOW = SPEC_NOW;
const clock: Clock = { now: () => NOW };

/** A strategy that always loses the race at the unique index, whatever the database holds. */
class ViolatingReservations extends SeatReservations {
  override hold(): Promise<HoldResult> {
    return Promise.resolve({ outcome: HOLD_OUTCOME.CONSTRAINT_VIOLATION });
  }
}

describe.each(Object.values(BOOKING_STRATEGY))('hold under %s', (strategy) => {
  const database = openTestDatabase();
  const { db } = database;
  const env = loadEnv();
  let redis: Redis;
  let service: BookingsService;

  beforeAll(async () => {
    redis = await openTestRedis();
    service = createBookingsService(db, redis, clock);
  });
  afterAll(async () => {
    await redis.quit();
    await database.close();
  });

  async function freeSeat(): Promise<{ eventId: string; seatId: string }> {
    const { eventId, seatIds } = await createTestEvent(db, { strategy, seats: 1 });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');
    return { eventId, seatId };
  }

  it('holds a free seat', async () => {
    const { eventId, seatId } = await freeSeat();
    const userId = randomUUID();

    const result = await service.hold({ eventId, seatId, userId, requestId: null });

    expect(result).toMatchObject({
      outcome: HOLD_OUTCOME.PLACED,
      holdExpiresAt: new Date(NOW.getTime() + env.HOLD_TTL_SECONDS * 1000),
    });
    const rows = await db.select().from(bookings).where(eq(bookings.seatId, seatId));
    expect(rows).toMatchObject([{ userId, status: BOOKING_STATUS.HELD, strategy }]);
    const transitions = await db
      .select()
      .from(bookingTransitions)
      .where(eq(bookingTransitions.bookingId, rows[0]?.id ?? ''));
    expect(transitions).toMatchObject([
      { fromStatus: null, toStatus: BOOKING_STATUS.HELD, reason: TRANSITION_REASON.HOLD },
    ]);
  });

  describe('audit', () => {
    const rowsOfRequest = async (requestId: string) =>
      (await auditRows(db)).filter((row) => row.requestId === requestId);

    // The table is shared by the three strategies of this file and by every other db spec.
    const requestId = (name: string) => `${name}-${randomUUID()}`;

    it('writes one BOOKING_HELD row with the holder, the booking and the request ID', async () => {
      const { eventId, seatId } = await freeSeat();
      const userId = randomUUID();
      const sent = requestId('req-hold');

      const result = await service.hold({ eventId, seatId, userId, requestId: sent });

      if (result.outcome !== HOLD_OUTCOME.PLACED) throw new Error('hold was not placed');
      expect(await rowsOfRequest(sent)).toMatchObject([
        {
          actorId: userId,
          action: AUDIT_ACTION.BOOKING_HELD,
          subjectType: AUDIT_SUBJECT.BOOKING,
          subjectId: result.bookingId,
        },
      ]);
    });

    it('writes no row for a hold without a request ID', async () => {
      const { eventId, seatId } = await freeSeat();
      const userId = randomUUID();

      await service.hold({ eventId, seatId, userId, requestId: null });

      expect((await auditRows(db)).filter((row) => row.actorId === userId)).toEqual([]);
    });

    it('writes no row for a seat that is taken or not in the event', async () => {
      const { eventId, seatId } = await freeSeat();
      const other = await freeSeat();
      await service.hold({ eventId, seatId, userId: randomUUID(), requestId: null });

      const taken = requestId('req-taken');
      const foreign = requestId('req-foreign');

      await service.hold({ eventId, seatId, userId: randomUUID(), requestId: taken });
      await service
        .hold({
          eventId,
          seatId: other.seatId,
          userId: randomUUID(),
          requestId: foreign,
        })
        .catch(() => undefined);

      expect(await rowsOfRequest(taken)).toEqual([]);
      expect(await rowsOfRequest(foreign)).toEqual([]);
    });
  });

  it('reports SEAT_TAKEN for a seat with an active hold', async () => {
    const { eventId, seatId } = await freeSeat();
    await service.hold({ eventId, seatId, userId: randomUUID(), requestId: null });

    const second = await service.hold({ eventId, seatId, userId: randomUUID(), requestId: null });

    expect(second).toEqual({ outcome: HOLD_OUTCOME.SEAT_TAKEN });
  });

  it.each([BOOKING_STATUS.PAID, BOOKING_STATUS.CONFIRMED])(
    'reports SEAT_TAKEN for a seat with a %s booking',
    async (status) => {
      const { eventId, seatId } = await freeSeat();
      await service.hold({ eventId, seatId, userId: randomUUID(), requestId: null });
      await db.update(bookings).set({ status }).where(eq(bookings.seatId, seatId));

      const second = await service.hold({ eventId, seatId, userId: randomUUID(), requestId: null });

      expect(second).toEqual({ outcome: HOLD_OUTCOME.SEAT_TAKEN });
    }
  );

  it.each([BOOKING_STATUS.EXPIRED, BOOKING_STATUS.CANCELLED])(
    'holds a seat again after its booking is %s',
    async (status) => {
      const { eventId, seatId } = await freeSeat();
      await service.hold({ eventId, seatId, userId: randomUUID(), requestId: null });
      await db.update(bookings).set({ status }).where(eq(bookings.seatId, seatId));

      const again = await service.hold({ eventId, seatId, userId: randomUUID(), requestId: null });

      expect(again.outcome).toBe(HOLD_OUTCOME.PLACED);
    }
  );

  it('rejects a seat of another event with NotFound and writes no row', async () => {
    const { eventId } = await freeSeat();
    const other = await freeSeat();

    await expect(
      service.hold({ eventId, seatId: other.seatId, userId: randomUUID(), requestId: null })
    ).rejects.toBeInstanceOf(NotFoundException);

    const [row] = await db
      .select({ n: count() })
      .from(bookings)
      .where(eq(bookings.seatId, other.seatId));
    expect(row?.n).toBe(0);
  });

  it('holds a seat of a sandbox event for its owner only; for anyone else the event is NotFound', async () => {
    const owner = randomUUID();
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy,
      seats: 1,
      sandboxUserId: owner,
    });
    const seatId = seatIds[0] ?? '';

    await expect(
      service.hold({ eventId, seatId, userId: randomUUID(), requestId: null })
    ).rejects.toBeInstanceOf(NotFoundException);
    const [untouched] = await db
      .select({ n: count() })
      .from(bookings)
      .where(eq(bookings.seatId, seatId));
    expect(untouched?.n).toBe(0);

    const held = await service.hold({ eventId, seatId, userId: owner, requestId: null });
    expect(held.outcome).toBe(HOLD_OUTCOME.PLACED);
  });

  describe('metrics', () => {
    const attempted = (outcome: string) => ({ method: 'holdAttempted', args: [strategy, outcome] });

    it('counts each attempt once with the strategy of the event and its outcome', async () => {
      const metrics = new RecordingMetrics();
      const counted = createBookingsService(
        db,
        redis,
        clock,
        undefined,
        undefined,
        undefined,
        metrics
      );
      const { eventId, seatId } = await freeSeat();

      await counted.hold({ eventId, seatId, userId: randomUUID(), requestId: null });
      await counted.hold({ eventId, seatId, userId: randomUUID(), requestId: null });

      expect(metrics.calls).toEqual([
        attempted(HOLD_OUTCOME.PLACED),
        attempted(HOLD_OUTCOME.SEAT_TAKEN),
      ]);
    });

    it('counts a lost race at the unique index as CONSTRAINT_VIOLATION', async () => {
      const metrics = new RecordingMetrics();
      const violating = new ViolatingReservations(db, redis, clock, {
        ttlSeconds: env.HOLD_TTL_SECONDS,
        audit: new AuditService(db, clock),
      });
      const counted = createBookingsService(
        db,
        redis,
        clock,
        undefined,
        undefined,
        undefined,
        metrics,
        violating
      );
      const { eventId, seatId } = await freeSeat();

      await counted.hold({ eventId, seatId, userId: randomUUID(), requestId: null });

      expect(metrics.calls).toEqual([attempted(HOLD_OUTCOME.CONSTRAINT_VIOLATION)]);
    });

    it('counts nothing for a seat that is not in the event', async () => {
      const metrics = new RecordingMetrics();
      const counted = createBookingsService(
        db,
        redis,
        clock,
        undefined,
        undefined,
        undefined,
        metrics
      );
      const { eventId } = await freeSeat();
      const other = await freeSeat();

      await expect(
        counted.hold({ eventId, seatId: other.seatId, userId: randomUUID(), requestId: null })
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(metrics.calls).toEqual([]);
    });
  });
});

describe('hold when UNSAFE_STRATEGIES_ENABLED is false', () => {
  const database = openTestDatabase();
  const { db } = database;
  const env = loadEnv();
  let redis: Redis;
  let service: BookingsService;

  beforeAll(async () => {
    redis = await openTestRedis();
    const reservations = new SeatReservations(db, redis, clock, {
      ttlSeconds: env.HOLD_TTL_SECONDS,
      audit: new AuditService(db, clock),
      unsafeStrategiesEnabled: false,
    });
    service = createBookingsService(
      db,
      redis,
      clock,
      undefined,
      undefined,
      undefined,
      undefined,
      reservations
    );
  });
  afterAll(async () => {
    await redis.quit();
    await database.close();
  });

  it('refuses a NAIVE hold with BadRequestException and writes no booking, while PESSIMISTIC succeeds', async () => {
    const naiveEvent = await createTestEvent(db, { strategy: BOOKING_STRATEGY.NAIVE, seats: 1 });
    const naiveSeatId = naiveEvent.seatIds[0] ?? '';

    await expect(
      service.hold({
        eventId: naiveEvent.eventId,
        seatId: naiveSeatId,
        userId: randomUUID(),
        requestId: null,
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    const rows = await db.select().from(bookings).where(eq(bookings.seatId, naiveSeatId));
    expect(rows).toEqual([]);

    const safeEvent = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const safeHold = await service.hold({
      eventId: safeEvent.eventId,
      seatId: safeEvent.seatIds[0] ?? '',
      userId: randomUUID(),
      requestId: null,
    });
    expect(safeHold.outcome).toBe(HOLD_OUTCOME.PLACED);
  });
});
