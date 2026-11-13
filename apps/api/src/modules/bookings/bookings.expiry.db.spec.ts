import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { BOOKING_STATUS, BOOKING_STRATEGY, SEAT_STATUS, TRANSITION_REASON } from '@app/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';
import { bookings, bookingTransitions } from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { watchSeatChanges } from '../../testing/seat-changes.js';
import { EXPIRY_SPEC_START } from '../../testing/time.js';
import type { BookingsService } from './bookings.service.js';
import { SYSTEM_ACTOR_ID } from './domain/booking-state-machine.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';

const START = EXPIRY_SPEC_START;
const LOCK_WAIT_MS = 1500;

describe('expireHolds', () => {
  const database = openTestDatabase();
  const { db } = database;
  const env = loadEnv();
  const ttlMs = env.HOLD_TTL_SECONDS * 1000;
  let now = START;
  let redis: Redis;
  let service: BookingsService;

  beforeAll(async () => {
    redis = await openTestRedis();
    service = createBookingsService(db, redis, { now: () => now });
  });
  afterAll(async () => {
    await redis.quit();
    await database.close();
  });

  /** Holds `count` seats at `heldAt`. */
  async function holds(count: number, heldAt: Date): Promise<string[]> {
    now = heldAt;
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: count,
    });
    const ids: string[] = [];
    for (const seatId of seatIds) {
      const result = await service.hold({ eventId, seatId, userId: randomUUID() });
      if (result.outcome !== HOLD_OUTCOME.PLACED) throw new Error('hold was not placed');
      ids.push(result.bookingId);
    }
    return ids;
  }

  async function statusOf(ids: string[]): Promise<string[]> {
    const rows = await db.select().from(bookings).where(inArray(bookings.id, ids));
    return rows.map((row) => row.status);
  }

  it('expires only holds whose time has passed and stores HOLD_EXPIRED', async () => {
    const [due] = await holds(1, START);
    const [later] = await holds(1, new Date(START.getTime() + ttlMs / 2));
    if (due === undefined || later === undefined) throw new Error('missing hold');

    const expired = await service.expireHolds(new Date(START.getTime() + ttlMs));

    expect(expired).toBeGreaterThanOrEqual(1);
    expect(await statusOf([due])).toEqual([BOOKING_STATUS.EXPIRED]);
    expect(await statusOf([later])).toEqual([BOOKING_STATUS.HELD]);
    const [record] = await db
      .select()
      .from(bookingTransitions)
      .where(
        and(
          eq(bookingTransitions.bookingId, due),
          eq(bookingTransitions.reason, TRANSITION_REASON.HOLD_EXPIRED)
        )
      );
    expect(record).toMatchObject({
      fromStatus: BOOKING_STATUS.HELD,
      toStatus: BOOKING_STATUS.EXPIRED,
      actorId: SYSTEM_ACTOR_ID,
    });
  });

  it('publishes AVAILABLE for each expired hold after the commit, and only for those', async () => {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 3,
    });
    const [dueA, dueB, later] = seatIds;
    for (const [seatId, heldAt] of [
      [dueA, START],
      [dueB, START],
      [later, new Date(START.getTime() + ttlMs / 2)],
    ] as const) {
      now = heldAt;
      await service.hold({ eventId, seatId: seatId ?? '', userId: randomUUID() });
    }
    const watch = await watchSeatChanges(redis, eventId);

    await service.expireHolds(new Date(START.getTime() + ttlMs));
    await watch.settle();
    await watch.stop();

    expect(watch.changes.map(({ seatId }) => seatId).toSorted()).toEqual([dueA, dueB].toSorted());
    expect(watch.changes.every(({ status }) => status === SEAT_STATUS.AVAILABLE)).toBe(true);
  });

  it('publishes only after the expiry is committed: a reader on another connection sees EXPIRED', async () => {
    const [id] = await holds(1, START);
    if (id === undefined) throw new Error('missing hold');
    const seenWhenPublished: string[] = [];
    const checking = createBookingsService(db, redis, { now: () => now }, undefined, {
      publish: async () => {
        seenWhenPublished.push(...(await statusOf([id])));
      },
    });

    await checking.expireHolds(new Date(START.getTime() + ttlMs));

    expect(seenWhenPublished).toEqual([BOOKING_STATUS.EXPIRED]);
  });

  it('two parallel expireHolds runs expire each hold once', async () => {
    const ids = await holds(20, START);
    const due = new Date(START.getTime() + ttlMs);

    await Promise.all(Array.from({ length: 4 }, () => service.expireHolds(due)));

    const records = await db
      .select()
      .from(bookingTransitions)
      .where(
        and(
          inArray(bookingTransitions.bookingId, ids),
          eq(bookingTransitions.reason, TRANSITION_REASON.HOLD_EXPIRED)
        )
      );
    expect(records).toHaveLength(ids.length);
  });

  it('skips a hold another transaction has locked instead of waiting for it', async () => {
    const [locked, free] = await holds(2, START);
    if (locked === undefined || free === undefined) throw new Error('missing hold');

    const outcome = await db.transaction(async (tx) => {
      await tx.select().from(bookings).where(eq(bookings.id, locked)).for('update');
      return Promise.race([
        service.expireHolds(new Date(START.getTime() + ttlMs)),
        delay(LOCK_WAIT_MS, null),
      ]);
    });

    expect(outcome).not.toBeNull();
    expect(await statusOf([free])).toEqual([BOOKING_STATUS.EXPIRED]);
    expect(await statusOf([locked])).toEqual([BOOKING_STATUS.HELD]);
  });
});
