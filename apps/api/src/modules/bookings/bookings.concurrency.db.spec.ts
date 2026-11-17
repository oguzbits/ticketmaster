import { randomUUID } from 'node:crypto';

import { AUDIT_ACTION, BOOKING_STRATEGY } from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../../core/clock.js';
import { bookings } from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import { auditRows } from '../audit/testing/index.js';
import type { BookingsService } from './bookings.service.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';

const PARALLEL_HOLDS = 50;
const clock: Clock = { now: () => SPEC_NOW };

describe.each(Object.values(BOOKING_STRATEGY))('%s: parallel holds of one seat', (strategy) => {
  const database = openTestDatabase();
  const { db } = database;
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

  it(`${PARALLEL_HOLDS} users race for one seat`, async () => {
    const { eventId, seatIds } = await createTestEvent(db, { strategy, seats: 1 });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');

    const results = await Promise.all(
      Array.from({ length: PARALLEL_HOLDS }, () =>
        service.hold({ eventId, seatIds: [seatId], userId: randomUUID(), requestId: randomUUID() })
      )
    );

    const doubles = await service.countDoubleBookings(eventId);
    const bookingIds = new Set(
      (
        await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.eventId, eventId))
      ).map(({ id }) => id)
    );
    const held = (await auditRows(db)).filter(
      (row) => row.action === AUDIT_ACTION.BOOKING_HELD && bookingIds.has(row.subjectId)
    );
    expect(held).toHaveLength(bookingIds.size);
    expect(bookingIds.size).toBe(
      results.filter((result) => result.outcome === HOLD_OUTCOME.PLACED).length
    );
    if (strategy === BOOKING_STRATEGY.NAIVE) {
      expect(doubles).toBeGreaterThan(0);
      return;
    }
    expect(doubles).toBe(0);
    const outcomes = results.map((result) => result.outcome);
    expect(outcomes.filter((outcome) => outcome === HOLD_OUTCOME.PLACED)).toHaveLength(1);
    expect(outcomes).not.toContain(HOLD_OUTCOME.CONSTRAINT_VIOLATION);
  });

  it(`${PARALLEL_HOLDS} users race on overlapping seat pairs in opposing orders without deadlocks`, async () => {
    const { eventId, seatIds } = await createTestEvent(db, { strategy, seats: 3 });
    const [s1, s2, s3] = seatIds;
    if (s1 === undefined || s2 === undefined || s3 === undefined) {
      throw new Error('test event missing seats');
    }
    const pairs = [
      [s1, s2],
      [s2, s1],
      [s2, s3],
      [s3, s2],
      [s1, s3],
    ];

    const results = await Promise.all(
      Array.from({ length: PARALLEL_HOLDS }, (_, index) =>
        service.hold({
          eventId,
          seatIds: pairs[index % pairs.length] ?? [s1, s2],
          userId: randomUUID(),
          requestId: randomUUID(),
        })
      )
    );

    const doubles = await service.countDoubleBookings(eventId);
    const placed = results.filter((result) => result.outcome === HOLD_OUTCOME.PLACED);
    if (strategy === BOOKING_STRATEGY.NAIVE) {
      expect(doubles).toBeGreaterThan(0);
      return;
    }
    expect(doubles).toBe(0);
    expect(placed).toHaveLength(1);
  });
});
