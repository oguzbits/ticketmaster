import { asc, eq } from 'drizzle-orm';

import type { Tx } from '../../../infrastructure/database/database.module.js';
import {
  bookings,
  bookingSeats,
  events,
  seats,
  venues,
} from '../../../infrastructure/database/schema.js';
import type { TicketData } from '../domain/ticket.js';

/**
 * The booking with its event, venue and seats; null when the booking does not exist. Acquires a
 * share lock on the booking row for the caller's transaction, serializing against a concurrent
 * cancel (which locks the row for update).
 */
export async function loadTicketData(tx: Tx, bookingId: string): Promise<TicketData | null> {
  const rows = await tx
    .select({
      bookingId: bookings.id,
      status: bookings.status,
      eventTitle: events.name,
      venueName: venues.name,
      startsAt: events.startsAt,
      section: seats.section,
      row: seats.row,
      number: seats.number,
    })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(venues, eq(venues.id, events.venueId))
    .innerJoin(bookingSeats, eq(bookingSeats.bookingId, bookings.id))
    .innerJoin(seats, eq(seats.id, bookingSeats.seatId))
    .where(eq(bookings.id, bookingId))
    .orderBy(asc(seats.section), asc(seats.row), asc(seats.number))
    .for('share', { of: bookings });
  const first = rows[0];
  if (first === undefined) return null;
  return {
    bookingId: first.bookingId,
    status: first.status,
    eventTitle: first.eventTitle,
    venueName: first.venueName,
    startsAt: first.startsAt,
    seats: rows.map(({ section, row, number }) => ({ section, row, number })),
  };
}
