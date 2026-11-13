import { BOOKING_STATUS, type BookingStatus, type OrganizerEvent, type Venue } from '@app/shared';
import { Inject, Injectable } from '@nestjs/common';
import { asc, count, eq, inArray, sql } from 'drizzle-orm';

import { type Database, DB } from '../../infrastructure/database/database.module.js';
import {
  bookings,
  events,
  seats,
  venues,
  venueSeats,
} from '../../infrastructure/database/schema.js';

@Injectable()
export class OrganizerService {
  constructor(@Inject(DB) private readonly db: Database) {}

  listVenues(): Promise<Venue[]> {
    return this.db
      .select({ id: venues.id, name: venues.name, seatCount: count(venueSeats.venueId) })
      .from(venues)
      .leftJoin(venueSeats, eq(venueSeats.venueId, venues.id))
      .groupBy(venues.id)
      .orderBy(asc(venues.name));
  }

  /** Own events with their sales; one statement counts seats, sold and held seats per event. */
  async listOwnEvents(ownerId: string): Promise<OrganizerEvent[]> {
    // A seat counts once per status group, so the NAIVE strategy's double bookings cannot push
    // sold seats past the seat count.
    const seatsWith = (statuses: BookingStatus[]) =>
      sql<number>`(select count(distinct ${bookings.seatId}) from ${bookings} where ${eq(bookings.eventId, events.id)} and ${inArray(bookings.status, statuses)})::int`;
    const rows = await this.db
      .select({
        id: events.id,
        name: events.name,
        startsAt: events.startsAt,
        venueName: venues.name,
        strategy: events.strategy,
        seatCount: sql<number>`(select count(*) from ${seats} where ${eq(seats.eventId, events.id)})::int`,
        soldCount: seatsWith([BOOKING_STATUS.PAID, BOOKING_STATUS.CONFIRMED]),
        heldCount: seatsWith([BOOKING_STATUS.HELD]),
      })
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(eq(events.ownerId, ownerId))
      .orderBy(asc(events.startsAt));
    return rows.map((row) => ({
      ...row,
      startsAt: row.startsAt.toISOString(),
      utilization: row.seatCount === 0 ? 0 : row.soldCount / row.seatCount,
    }));
  }
}
