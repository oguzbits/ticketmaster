import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY } from '@app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../../core/clock.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import type { BookingsService } from './bookings.service.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';

const PARALLEL_HOLDS = 50;
const clock: Clock = { now: () => new Date() };

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
        service.hold({ eventId, seatId, userId: randomUUID() })
      )
    );

    const doubles = await service.countDoubleBookings(eventId);
    if (strategy === BOOKING_STRATEGY.NAIVE) {
      expect(doubles).toBeGreaterThan(0);
      return;
    }
    expect(doubles).toBe(0);
    const outcomes = results.map((result) => result.outcome);
    expect(outcomes.filter((outcome) => outcome === HOLD_OUTCOME.PLACED)).toHaveLength(1);
    expect(outcomes).not.toContain(HOLD_OUTCOME.CONSTRAINT_VIOLATION);
  });
});
