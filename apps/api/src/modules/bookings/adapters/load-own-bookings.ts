import type { Booking } from '@app/shared';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { bookings, bookingTransitions, seats } from '../../../infrastructure/database/schema.js';

/** The user's bookings with their stored transitions, newest booking first. */
export async function loadOwnBookings(
  db: Database,
  userId: string,
  extra?: SQL
): Promise<Booking[]> {
  const rows = await db
    .select({
      id: bookings.id,
      eventId: bookings.eventId,
      seatId: bookings.seatId,
      status: bookings.status,
      holdExpiresAt: bookings.holdExpiresAt,
      section: seats.section,
      row: seats.row,
      number: seats.number,
    })
    .from(bookings)
    .innerJoin(seats, eq(seats.id, bookings.seatId))
    .where(and(eq(bookings.userId, userId), extra))
    .orderBy(desc(bookings.createdAt));
  if (rows.length === 0) return [];
  // The steps of one payment share a timestamp; the status enum order (HELD < PAID < CONFIRMED)
  // keeps them newest first.
  const stored = await db
    .select()
    .from(bookingTransitions)
    .where(
      inArray(
        bookingTransitions.bookingId,
        rows.map(({ id }) => id)
      )
    )
    .orderBy(desc(bookingTransitions.at), desc(bookingTransitions.toStatus));
  return rows.map(({ section, row, number, holdExpiresAt, ...booking }) => ({
    ...booking,
    holdExpiresAt: holdExpiresAt.toISOString(),
    seat: { section, row, number },
    transitions: stored
      .filter(({ bookingId }) => bookingId === booking.id)
      .map(({ fromStatus, toStatus, reason, at }) => ({
        fromStatus,
        toStatus,
        reason,
        at: at.toISOString(),
      })),
  }));
}
