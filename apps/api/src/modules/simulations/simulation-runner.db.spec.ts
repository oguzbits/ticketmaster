import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, type BookingStrategy } from '@app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../../core/clock.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import { createBookingsService } from '../bookings/index.js';
import { SimulationRunner } from './index.js';

const BUYERS = 100;
const SEATS = 5;
const CONCURRENCY = 40;
const PROGRESS_INTERVAL_MS = 250;
const clock: Clock = { now: () => SPEC_NOW };

describe('SimulationRunner against the database', () => {
  const database = openTestDatabase();
  const { db } = database;
  let redis: Redis;

  beforeAll(async () => {
    redis = await openTestRedis();
  });
  afterAll(async () => {
    await redis.quit();
    await database.close();
  });

  function runnerWith(random: () => number): SimulationRunner {
    return new SimulationRunner({
      bookings: createBookingsService(db, redis, clock),
      clock,
      random,
      newUserId: randomUUID,
      intervalMs: PROGRESS_INTERVAL_MS,
    });
  }

  function rush(strategy: BookingStrategy, buyers: number, seats: number, random: () => number) {
    return createTestEvent(db, { strategy, seats }).then(({ eventId, seatIds }) =>
      runnerWith(random).run({
        runId: randomUUID(),
        eventId,
        buyers,
        seats: seatIds,
        concurrency: CONCURRENCY,
        onProgress: () => undefined,
      })
    );
  }

  it.each(Object.values(BOOKING_STRATEGY))(
    `%s: ${BUYERS} buyers on ${SEATS} seats count the double bookings from the database`,
    async (strategy) => {
      const metrics = await rush(strategy, BUYERS, SEATS, Math.random);

      expect(metrics.buyersDone).toBe(BUYERS);
      if (strategy === BOOKING_STRATEGY.NAIVE) {
        expect(metrics.doubleBookings).toBeGreaterThan(0);
        return;
      }
      expect(metrics.doubleBookings).toBe(0);
      expect(metrics.constraintViolations).toBe(0);
      expect(metrics.holds).toBeLessThanOrEqual(SEATS);
    }
  );

  it('10 buyers on 100 seats all hold a seat without a conflict or a retry', async () => {
    const seats = 100;
    let next = 0;
    // One distinct seat per buyer, so no two buyers can collide.
    const random = () => (next++ + 0.5) / seats;

    const metrics = await rush(BOOKING_STRATEGY.PESSIMISTIC, 10, seats, random);

    expect(metrics).toMatchObject({ holds: 10, conflicts: 0, retries: 0, doubleBookings: 0 });
  });
});
