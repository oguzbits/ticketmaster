import { randomUUID } from 'node:crypto';

import { BOOKING_STATUS, BOOKING_STRATEGY, TRANSITION_REASON } from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { bookings, bookingTransitions } from '../../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../../testing/database.js';
import { SPEC_NOW } from '../../../testing/time.js';
import type { TransitionResult } from '../domain/booking-state-machine.js';
import { storeOwnTransition } from './booking-transitions.js';

const HOLD_MS = 600_000;

describe('storeOwnTransition', () => {
  const database = openTestDatabase();
  const { db } = database;

  afterAll(() => database.close());

  /** A HELD booking of `userId` and the transition that cancels it, planned by hand. */
  async function heldBooking(userId: string): Promise<TransitionResult> {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const holdExpiresAt = new Date(SPEC_NOW.getTime() + HOLD_MS);
    const [row] = await db
      .insert(bookings)
      .values({
        eventId,
        seatId: seatIds[0] ?? '',
        userId,
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        status: BOOKING_STATUS.HELD,
        holdExpiresAt,
      })
      .returning({ id: bookings.id });
    if (row === undefined) throw new Error('insert returned no row');
    return {
      booking: { id: row.id, status: BOOKING_STATUS.CANCELLED, holdExpiresAt },
      record: {
        bookingId: row.id,
        fromStatus: BOOKING_STATUS.HELD,
        toStatus: BOOKING_STATUS.CANCELLED,
        reason: TRANSITION_REASON.CANCELLED_BY_USER,
        actorId: userId,
        at: SPEC_NOW,
      },
    };
  }

  const statusOf = async (bookingId: string) =>
    (
      await db.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, bookingId))
    )[0]?.status;
  const transitionsOf = (bookingId: string) =>
    db.select().from(bookingTransitions).where(eq(bookingTransitions.bookingId, bookingId));

  it('stores the status and the record of the caller’s own booking', async () => {
    const owner = randomUUID();
    const result = await heldBooking(owner);

    await db.transaction((tx) => storeOwnTransition(tx, owner, result));

    expect(await statusOf(result.booking.id)).toBe(BOOKING_STATUS.CANCELLED);
    expect(await transitionsOf(result.booking.id)).toHaveLength(1);
  });

  it('refuses to write for a booking of someone else and stores nothing', async () => {
    const result = await heldBooking(randomUUID());

    const attempt = db.transaction((tx) => storeOwnTransition(tx, randomUUID(), result));

    await expect(attempt).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/violates row-level security policy/) },
    });
    expect(await statusOf(result.booking.id)).toBe(BOOKING_STATUS.HELD);
    expect(await transitionsOf(result.booking.id)).toEqual([]);
  });
});
