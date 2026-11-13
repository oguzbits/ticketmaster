import { randomUUID } from 'node:crypto';

import { BOOKING_STATUS, BOOKING_STRATEGY, TRANSITION_REASON } from '@app/shared';
import { NotFoundException } from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';
import type { Clock } from '../../core/clock.js';
import { bookings, bookingTransitions } from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import type { BookingsService } from './bookings.service.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';

const NOW = SPEC_NOW;
const clock: Clock = { now: () => NOW };

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

    const result = await service.hold({ eventId, seatId, userId });

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

  it('reports SEAT_TAKEN for a seat with an active hold', async () => {
    const { eventId, seatId } = await freeSeat();
    await service.hold({ eventId, seatId, userId: randomUUID() });

    const second = await service.hold({ eventId, seatId, userId: randomUUID() });

    expect(second).toEqual({ outcome: HOLD_OUTCOME.SEAT_TAKEN });
  });

  it.each([BOOKING_STATUS.PAID, BOOKING_STATUS.CONFIRMED])(
    'reports SEAT_TAKEN for a seat with a %s booking',
    async (status) => {
      const { eventId, seatId } = await freeSeat();
      await service.hold({ eventId, seatId, userId: randomUUID() });
      await db.update(bookings).set({ status }).where(eq(bookings.seatId, seatId));

      const second = await service.hold({ eventId, seatId, userId: randomUUID() });

      expect(second).toEqual({ outcome: HOLD_OUTCOME.SEAT_TAKEN });
    }
  );

  it.each([BOOKING_STATUS.EXPIRED, BOOKING_STATUS.CANCELLED])(
    'holds a seat again after its booking is %s',
    async (status) => {
      const { eventId, seatId } = await freeSeat();
      await service.hold({ eventId, seatId, userId: randomUUID() });
      await db.update(bookings).set({ status }).where(eq(bookings.seatId, seatId));

      const again = await service.hold({ eventId, seatId, userId: randomUUID() });

      expect(again.outcome).toBe(HOLD_OUTCOME.PLACED);
    }
  );

  it('rejects a seat of another event with NotFound and writes no row', async () => {
    const { eventId } = await freeSeat();
    const other = await freeSeat();

    await expect(
      service.hold({ eventId, seatId: other.seatId, userId: randomUUID() })
    ).rejects.toBeInstanceOf(NotFoundException);

    const [row] = await db
      .select({ n: count() })
      .from(bookings)
      .where(eq(bookings.seatId, other.seatId));
    expect(row?.n).toBe(0);
  });
});
