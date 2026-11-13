import {
  BOOKING_STATUS,
  type BookingStatus,
  type CreateEventRequest,
  type EventSummary,
  type OrganizerEvent,
  type Venue,
} from '@app/shared';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, count, eq, inArray, sql } from 'drizzle-orm';

import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import {
  bookings,
  demoUsers,
  events,
  seats,
  venues,
  venueSeats,
} from '../../infrastructure/database/schema.js';

@Injectable()
export class OrganizerService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * One transaction: the event and a copy of the venue's seats with their prices. The event of a
   * demo user is a sandbox event, so a visitor's event stays private to them.
   */
  async createEvent(input: CreateEventRequest, ownerId: string): Promise<EventSummary> {
    const startsAt = new Date(input.startsAt);
    if (startsAt.getTime() <= this.clock.now().getTime()) {
      throw new BadRequestException('startsAt must lie in the future');
    }
    return this.db.transaction(async (tx) => {
      const [venue] = await tx
        .select({ id: venues.id, name: venues.name })
        .from(venues)
        .where(eq(venues.id, input.venueId));
      if (venue === undefined) throw new NotFoundException('Venue not found');
      const [demoUser] = await tx
        .select({ userId: demoUsers.userId })
        .from(demoUsers)
        .where(eq(demoUsers.userId, ownerId));
      const [event] = await tx
        .insert(events)
        .values({
          venueId: venue.id,
          name: input.name,
          startsAt,
          strategy: input.strategy,
          ownerId,
          sandboxUserId: demoUser === undefined ? null : ownerId,
        })
        .returning({ id: events.id });
      if (event === undefined) throw new Error('event insert returned no row');
      // One INSERT ... SELECT in the database; drizzle's insert-select wants every column of seats.
      await tx.execute(sql`
        insert into ${seats} (event_id, section, row, number, price_cents)
        select ${event.id}::uuid, section, row, number, price_cents
        from ${venueSeats}
        where venue_id = ${venue.id}
      `);
      return {
        id: event.id,
        name: input.name,
        startsAt: startsAt.toISOString(),
        venueName: venue.name,
        strategy: input.strategy,
      };
    });
  }

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
