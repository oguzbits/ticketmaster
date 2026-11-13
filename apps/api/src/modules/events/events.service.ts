import type { EventDetail, EventSummary } from '@app/shared';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { bookings, events, seats, venues } from '../../infrastructure/database/schema.js';
import { ACTIVE_BOOKING_STATUSES, seatStatusOf } from '../bookings/index.js';

@Injectable()
export class EventsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(): Promise<EventSummary[]> {
    const rows = await this.db
      .select({
        id: events.id,
        name: events.name,
        startsAt: events.startsAt,
        venueName: venues.name,
        strategy: events.strategy,
      })
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(isNull(events.sandboxUserId))
      .orderBy(asc(events.startsAt));
    return rows.map((row) => ({ ...row, startsAt: row.startsAt.toISOString() }));
  }

  /** A sandbox event is private to its demo user, so it does not exist here. */
  async detail(id: string): Promise<EventDetail> {
    const [event] = await this.db
      .select({
        id: events.id,
        name: events.name,
        startsAt: events.startsAt,
        venueName: venues.name,
        strategy: events.strategy,
      })
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(and(eq(events.id, id), isNull(events.sandboxUserId)));
    if (event === undefined) throw new NotFoundException('Event not found');

    // One row per seat: the NAIVE comparison strategy can hold several active bookings of a seat,
    // so the scalar subquery picks the furthest one (enum order: HELD < PAID < CONFIRMED).
    const rows = await this.db
      .select({
        id: seats.id,
        section: seats.section,
        row: seats.row,
        number: seats.number,
        priceCents: seats.priceCents,
        activeStatus: sql<
          (typeof ACTIVE_BOOKING_STATUSES)[number] | null
        >`(select ${bookings.status} from ${bookings} where ${eq(bookings.seatId, seats.id)} and ${inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES])} order by ${bookings.status} desc limit 1)`,
      })
      .from(seats)
      .where(eq(seats.eventId, id))
      .orderBy(asc(seats.section), asc(seats.row), asc(seats.number));

    return {
      ...event,
      startsAt: event.startsAt.toISOString(),
      seats: rows.map(({ activeStatus, ...seat }) => ({
        ...seat,
        status: seatStatusOf(activeStatus),
      })),
    };
  }
}
