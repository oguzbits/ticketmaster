import { randomUUID } from 'node:crypto';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  type BookingStatus,
  type BookingStrategy,
} from '@app/shared';
import { count, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import type { Database } from './database.module.js';
import { bookings, events, seats, venues, venueSeats } from './schema.js';
import { SEED, seed } from './seed.js';

const HOLD_MS = 600_000;
const UNIQUE_VIOLATION = '23505';
const ACTIVE_SEAT_INDEX = 'bookings_active_seat_uidx';

describe('booking schema', () => {
  const database = openTestDatabase();
  const db: Database = database.db;

  afterAll(() => database.close());

  async function book(
    strategy: BookingStrategy,
    status: BookingStatus
  ): Promise<{ eventId: string; seatId: string }> {
    const { eventId, seatIds } = await createTestEvent(db, { strategy, seats: 1 });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');
    await insertBooking(eventId, seatId, strategy, status);
    return { eventId, seatId };
  }

  async function insertBooking(
    eventId: string,
    seatId: string,
    strategy: BookingStrategy,
    status: BookingStatus
  ): Promise<void> {
    await db.insert(bookings).values({
      eventId,
      seatId,
      userId: randomUUID(),
      strategy,
      status,
      holdExpiresAt: new Date(Date.now() + HOLD_MS),
    });
  }

  it('two active bookings of a PESSIMISTIC event on one seat violate bookings_active_seat_uidx', async () => {
    const { eventId, seatId } = await book(BOOKING_STRATEGY.PESSIMISTIC, BOOKING_STATUS.HELD);

    await expect(
      insertBooking(eventId, seatId, BOOKING_STRATEGY.PESSIMISTIC, BOOKING_STATUS.PAID)
    ).rejects.toMatchObject({
      cause: { code: UNIQUE_VIOLATION, constraint_name: ACTIVE_SEAT_INDEX },
    });
  });

  it('two active NAIVE bookings on one seat are accepted', async () => {
    const { eventId, seatId } = await book(BOOKING_STRATEGY.NAIVE, BOOKING_STATUS.HELD);

    await expect(
      insertBooking(eventId, seatId, BOOKING_STRATEGY.NAIVE, BOOKING_STATUS.HELD)
    ).resolves.toBeUndefined();
  });

  it('an EXPIRED and a HELD booking on one seat are accepted', async () => {
    const { eventId, seatId } = await book(BOOKING_STRATEGY.OPTIMISTIC, BOOKING_STATUS.EXPIRED);

    await expect(
      insertBooking(eventId, seatId, BOOKING_STRATEGY.OPTIMISTIC, BOOKING_STATUS.HELD)
    ).resolves.toBeUndefined();
  });

  it('seed() twice leaves the same row counts', async () => {
    async function seededRows(): Promise<number[]> {
      const venueIds = Object.values(SEED.VENUE_IDS);
      const eventIds = Object.values(SEED.EVENT_IDS);
      const counts = await Promise.all([
        db.select({ n: count() }).from(venues).where(inArray(venues.id, venueIds)),
        db.select({ n: count() }).from(venueSeats).where(inArray(venueSeats.venueId, venueIds)),
        db.select({ n: count() }).from(events).where(inArray(events.id, eventIds)),
        db.select({ n: count() }).from(seats).where(inArray(seats.eventId, eventIds)),
      ]);
      return counts.map(([row]) => row?.n ?? -1);
    }

    await seed(db);
    const first = await seededRows();
    await seed(db);

    expect(await seededRows()).toEqual(first);
    expect(first).toEqual([2, 272, 4, 544]);
  });
});
