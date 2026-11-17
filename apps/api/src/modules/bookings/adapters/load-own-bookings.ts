import type { Booking } from '@app/shared';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';

import type { Database, Tx } from '../../../infrastructure/database/database.module.js';
import { withOwner } from '../../../infrastructure/database/rls.js';
import {
  bookings,
  bookingSeats,
  bookingTransitions,
  seats,
} from '../../../infrastructure/database/schema.js';

/** The user's bookings with their seats and stored transitions, newest booking first. */
export async function loadOwnBookings(
  db: Database,
  userId: string,
  extra?: SQL
): Promise<Booking[]> {
  // The user scope backs the `user_id` filter below: a forgotten filter returns nothing foreign.
  return db.transaction((tx) => withOwner(tx, userId, () => queryOwnBookings(tx, userId, extra)));
}

async function queryOwnBookings(tx: Tx, userId: string, extra?: SQL): Promise<Booking[]> {
  const rows = await tx
    .select({
      id: bookings.id,
      eventId: bookings.eventId,
      status: bookings.status,
      holdExpiresAt: bookings.holdExpiresAt,
      ticketReadyAt: bookings.ticketReadyAt,
    })
    .from(bookings)
    .where(and(eq(bookings.userId, userId), extra))
    .orderBy(desc(bookings.createdAt));
  if (rows.length === 0) return [];
  const bookingIds = rows.map(({ id }) => id);
  const seatRows = await tx
    .select({
      bookingId: bookingSeats.bookingId,
      id: seats.id,
      section: seats.section,
      row: seats.row,
      number: seats.number,
      priceCents: seats.priceCents,
    })
    .from(bookingSeats)
    .innerJoin(seats, eq(seats.id, bookingSeats.seatId))
    .where(inArray(bookingSeats.bookingId, bookingIds))
    .orderBy(asc(seats.section), asc(seats.row), asc(seats.number));
  // The steps of one payment share a timestamp; the status enum order (HELD < PAID < CONFIRMED)
  // keeps them newest first.
  const stored = await tx
    .select()
    .from(bookingTransitions)
    .where(inArray(bookingTransitions.bookingId, bookingIds))
    .orderBy(desc(bookingTransitions.at), desc(bookingTransitions.toStatus));
  return rows.map(({ holdExpiresAt, ticketReadyAt, ...booking }) => {
    const bookedSeats = seatRows
      .filter(({ bookingId }) => bookingId === booking.id)
      .map(({ id, section, row, number, priceCents }) => ({
        id,
        section,
        row,
        number,
        priceCents,
      }));
    return {
      ...booking,
      holdExpiresAt: holdExpiresAt.toISOString(),
      ticketReady: ticketReadyAt !== null,
      totalPriceCents: bookedSeats.reduce((sum, seat) => sum + seat.priceCents, 0),
      seats: bookedSeats,
      transitions: stored
        .filter(({ bookingId }) => bookingId === booking.id)
        .map(({ fromStatus, toStatus, reason, at }) => ({
          fromStatus,
          toStatus,
          reason,
          at: at.toISOString(),
        })),
    };
  });
}
