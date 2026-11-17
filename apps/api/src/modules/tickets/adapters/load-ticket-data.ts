import { eq } from 'drizzle-orm';

import type { Tx } from '../../../infrastructure/database/database.module.js';
import { bookings, events, seats, venues } from '../../../infrastructure/database/schema.js';
import type { TicketData } from '../domain/ticket.js';

/**
 * The booking with its event, venue and seat; null when the booking does not exist. Acquires a
 * share lock on the booking row for the caller's transaction, serializing against a concurrent
 * cancel (which locks the row for update).
 */
export async function loadTicketData(tx: Tx, bookingId: string): Promise<TicketData | null> {
  const [row] = await tx
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
    .innerJoin(seats, eq(seats.id, bookings.seatId))
    .where(eq(bookings.id, bookingId))
    .for('share', { of: bookings });
  if (row === undefined) return null;
  const { section, row: seatRow, number, ...rest } = row;
  return { ...rest, seat: { section, row: seatRow, number } };
}
