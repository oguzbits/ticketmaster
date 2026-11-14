import { eq } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { bookings, events, seats, venues } from '../../../infrastructure/database/schema.js';
import type { TicketData } from '../domain/ticket.js';

/** The booking with its event, venue and seat; null when the booking does not exist. */
export async function loadTicketData(db: Database, bookingId: string): Promise<TicketData | null> {
  const [row] = await db
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
    .where(eq(bookings.id, bookingId));
  if (row === undefined) return null;
  const { section, row: seatRow, number, ...rest } = row;
  return { ...rest, seat: { section, row: seatRow, number } };
}
