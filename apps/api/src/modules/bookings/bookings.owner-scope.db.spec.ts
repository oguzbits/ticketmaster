import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY } from '@app/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';
import { RLS_SETTING } from '../../infrastructure/database/rls.js';
import * as schema from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import type { BookingsService } from './bookings.service.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';

interface Sent {
  text: string;
  params: readonly unknown[];
}

/**
 * The customer paths run in the user scope. Their `user_id` filters already answer correctly, so
 * the scope is only visible in what reaches the database: these specs read the statements of one
 * connection (the protocol level, no mock) and look for the scope before the guarded statement.
 */
describe('customer paths set the user scope', () => {
  const sent: Sent[] = [];
  const client = postgres(loadEnv().DATABASE_URL, {
    max: 1,
    debug: (_connection, text, params) => sent.push({ text, params }),
  });
  const db = drizzle(client, { schema });
  let redis: Redis;
  let service: BookingsService;

  beforeAll(async () => {
    redis = await openTestRedis();
    service = createBookingsService(db, redis, { now: () => SPEC_NOW });
  });
  afterAll(async () => {
    await redis.quit();
    await client.end();
  });

  async function heldBooking(): Promise<{ bookingId: string; userId: string }> {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const userId = randomUUID();
    const result = await service.hold({
      eventId,
      seatIds: [seatIds[0] ?? ''],
      userId,
      requestId: null,
    });
    if (result.outcome !== HOLD_OUTCOME.PLACED) throw new Error('hold was not placed');
    return { bookingId: result.bookingId, userId };
  }

  /** True when the user scope for `userId` was set before the first statement that matches. */
  function scopedBefore(userId: string, guarded: RegExp): boolean {
    const guardedAt = sent.findIndex(({ text }) => guarded.test(text));
    const scopeAt = sent.findIndex(
      ({ text, params }) =>
        text.includes('set_config') &&
        params.includes(RLS_SETTING.USER_ID) &&
        params.includes(userId)
    );
    return guardedAt >= 0 && scopeAt >= 0 && scopeAt < guardedAt;
  }

  it('listing the own bookings', async () => {
    const { userId } = await heldBooking();
    sent.length = 0;

    await service.listOwn(userId);

    expect(scopedBefore(userId, /from "bookings"/)).toBe(true);
  });

  it('paying writes its transitions in the scope', async () => {
    const { bookingId, userId } = await heldBooking();
    sent.length = 0;

    await service.pay({ bookingId, userId, idempotencyKey: randomUUID(), requestId: 'spec' });

    expect(scopedBefore(userId, /insert into "booking_transitions"/)).toBe(true);
  });

  it('cancelling writes its transition in the scope', async () => {
    const { bookingId, userId } = await heldBooking();
    sent.length = 0;

    await service.cancel({ bookingId, userId, requestId: 'spec' });

    expect(scopedBefore(userId, /insert into "booking_transitions"/)).toBe(true);
  });
});
