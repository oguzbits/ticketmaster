import { randomUUID } from 'node:crypto';

import { BOOKING_STATUS, BOOKING_STRATEGY, TRANSITION_REASON } from '@app/shared';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';
import { createTestEvent } from '../../testing/database.js';
import type { Database } from './database.module.js';
import { RLS_SCOPE, RLS_SETTING, withOwner } from './rls.js';
import * as schema from './schema.js';

const { bookings, bookingSeats, bookingTransitions } = schema;
const HOLD_MS = 600_000;
const SEATS = 3;

// One connection: the same server connection serves every transaction, like a pooled one.
const client = postgres(loadEnv().DATABASE_URL, { max: 1 });
const db: Database = drizzle(client, { schema });

const userA = randomUUID();
const userB = randomUUID();
let eventId: string;
let seatIds: string[];
let bookingA: string;
let bookingB: string;

/** No `returning`: that would also apply the read policy and hide what the write check does. */
async function insertBooking(
  database: Pick<Database, 'insert'>,
  seatId: string,
  userId: string
): Promise<string> {
  const id = randomUUID();
  await database.insert(bookings).values({
    id,
    eventId,
    userId,
    strategy: BOOKING_STRATEGY.PESSIMISTIC,
    status: BOOKING_STATUS.HELD,
    holdExpiresAt: new Date(Date.now() + HOLD_MS),
  });
  await database.insert(bookingSeats).values({
    bookingId: id,
    eventId,
    seatId,
    strategy: BOOKING_STRATEGY.PESSIMISTIC,
    status: BOOKING_STATUS.HELD,
  });
  return id;
}

/** Ids of the bookings of this spec's event that the transaction can see. */
async function visibleBookings(tx: Pick<Database, 'select'>): Promise<string[]> {
  const rows = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.eventId, eventId));
  return rows.map((row) => row.id).sort();
}

describe('row-level security on bookings', () => {
  beforeAll(async () => {
    ({ eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: SEATS,
    }));
    bookingA = await insertBooking(db, seatIds[0] ?? '', userA);
    bookingB = await insertBooking(db, seatIds[1] ?? '', userB);
    await db.insert(bookingTransitions).values({
      bookingId: bookingB,
      toStatus: BOOKING_STATUS.HELD,
      reason: TRANSITION_REASON.HOLD,
      actorId: userB,
    });
  });
  afterAll(() => client.end());

  it("hides another user's booking from a read in the user scope", async () => {
    const seen = await db.transaction((tx) => withOwner(tx, userA, () => visibleBookings(tx)));

    expect(seen).toEqual([bookingA]);
  });

  it("changes nothing of another user's booking with an update or a delete", async () => {
    const touched = await db.transaction((tx) =>
      withOwner(tx, userA, async () => {
        const updated = await tx
          .update(bookings)
          .set({ status: BOOKING_STATUS.CANCELLED })
          .where(eq(bookings.id, bookingB))
          .returning({ id: bookings.id });
        const deleted = await tx
          .delete(bookings)
          .where(eq(bookings.id, bookingB))
          .returning({ id: bookings.id });
        return [...updated, ...deleted];
      })
    );

    expect(touched).toEqual([]);
    expect(await visibleBookings(db)).toContain(bookingB);
  });

  it('refuses an insert for another user in the user scope', async () => {
    const attempt = db.transaction((tx) =>
      withOwner(tx, userA, () => insertBooking(tx, seatIds[2] ?? '', userB))
    );

    await expect(attempt).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/violates row-level security policy/) },
    });
  });

  it('sees nothing in the user scope when no user is named', async () => {
    const seen = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config(${RLS_SETTING.SCOPE}, ${RLS_SCOPE.USER}, true)`);
      return visibleBookings(tx);
    });

    expect(seen).toEqual([]);
  });

  it('shows every booking without a scope, as the worker and the cross-user reads need', async () => {
    expect(await visibleBookings(db)).toEqual([bookingA, bookingB].sort());
  });

  it('hides the transitions and seats of another user in the user scope', async () => {
    const seenTransitions = await db.transaction((tx) =>
      withOwner(tx, userA, () =>
        tx
          .select({ id: bookingTransitions.id })
          .from(bookingTransitions)
          .where(eq(bookingTransitions.bookingId, bookingB))
      )
    );
    const seenSeats = await db.transaction((tx) =>
      withOwner(tx, userA, () =>
        tx
          .select({ seatId: bookingSeats.seatId })
          .from(bookingSeats)
          .where(eq(bookingSeats.bookingId, bookingB))
      )
    );

    expect(seenTransitions).toEqual([]);
    expect(seenSeats).toEqual([]);
  });

  describe('withOwner', () => {
    it('gives the rest of the transaction its full view back', async () => {
      const seen = await db.transaction(async (tx) => {
        await withOwner(tx, userA, () => visibleBookings(tx));
        return visibleBookings(tx);
      });

      expect(seen).toEqual([bookingA, bookingB].sort());
    });

    it('leaves nothing behind for the next transaction on the same connection', async () => {
      await db.transaction((tx) => withOwner(tx, userA, () => visibleBookings(tx)));
      await expect(
        db.transaction((tx) =>
          withOwner(tx, userA, () => Promise.reject(new Error('stop the transaction')))
        )
      ).rejects.toThrow('stop the transaction');

      const [row] = await client`select current_setting(${RLS_SETTING.USER_ID}, true) as user_id`;
      expect(row?.['user_id'] ?? '').toBe('');
      expect(await visibleBookings(db)).toEqual([bookingA, bookingB].sort());
    });
  });
});
