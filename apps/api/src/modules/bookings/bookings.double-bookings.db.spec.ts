import { randomUUID } from 'node:crypto';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  type BookingStatus,
  type BookingStrategy,
} from '@app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bookings } from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import type { BookingsService } from './bookings.service.js';
import { createBookingsService } from './testing/create-bookings-service.js';

const HOLD_MS = 600_000;

describe('countDoubleBookings', () => {
  const database = openTestDatabase();
  const { db } = database;
  let redis: Redis;
  let service: BookingsService;

  beforeAll(async () => {
    redis = await openTestRedis();
    service = createBookingsService(db, redis, { now: () => SPEC_NOW });
  });
  afterAll(async () => {
    await redis.quit();
    await database.close();
  });

  async function countFor(
    strategy: BookingStrategy,
    statuses: readonly BookingStatus[]
  ): Promise<number> {
    const { eventId, seatIds } = await createTestEvent(db, { strategy, seats: 1 });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');
    await db.insert(bookings).values(
      statuses.map((status) => ({
        eventId,
        seatId,
        userId: randomUUID(),
        strategy,
        status,
        holdExpiresAt: new Date(SPEC_NOW.getTime() + HOLD_MS),
      }))
    );
    return service.countDoubleBookings(eventId);
  }

  it('does not count an expired booking next to an active one', async () => {
    expect(
      await countFor(BOOKING_STRATEGY.PESSIMISTIC, [BOOKING_STATUS.EXPIRED, BOOKING_STATUS.HELD])
    ).toBe(0);
  });

  it('counts the active bookings of a seat beyond the first', async () => {
    expect(await countFor(BOOKING_STRATEGY.NAIVE, [BOOKING_STATUS.HELD, BOOKING_STATUS.HELD])).toBe(
      1
    );
  });
});
