import type { BookingStrategy, EventDetail, EventSummary } from '@app/shared';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';

import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { bookings, events, seats, venues } from '../../infrastructure/database/schema.js';
import { ACTIVE_BOOKING_STATUSES, seatStatusOf } from '../bookings/index.js';

/** Public events, plus the sandbox events of the caller. */
function visibleTo(userId: string | null): SQL | undefined {
  return userId === null
    ? isNull(events.sandboxUserId)
    : or(isNull(events.sandboxUserId), eq(events.sandboxUserId, userId));
}

const summaryColumns = {
  id: events.id,
  name: events.name,
  startsAt: events.startsAt,
  venueName: venues.name,
  strategy: events.strategy,
};

@Injectable()
export class EventsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(userId: string | null): Promise<EventSummary[]> {
    const rows = await this.db
      .select(summaryColumns)
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(visibleTo(userId))
      .orderBy(asc(events.startsAt));
    return rows.map((row) => ({ ...row, startsAt: row.startsAt.toISOString() }));
  }

  /** NotFound unless the event is public or the caller's own sandbox; cheaper than `detail`. */
  async assertVisible(id: string, userId: string | null): Promise<void> {
    const [event] = await this.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, id), visibleTo(userId)));
    if (event === undefined) throw new NotFoundException('Event not found');
  }

  /** Admin switch: later holds use the new strategy, existing bookings keep their own. */
  async setStrategy(id: string, strategy: BookingStrategy): Promise<EventSummary> {
    const [updated] = await this.db
      .update(events)
      .set({ strategy })
      .where(eq(events.id, id))
      .returning({ id: events.id });
    if (updated === undefined) throw new NotFoundException('Event not found');
    const [event] = await this.db
      .select(summaryColumns)
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(eq(events.id, id));
    if (event === undefined) throw new NotFoundException('Event not found');
    return { ...event, startsAt: event.startsAt.toISOString() };
  }

  /** A sandbox event is private to its demo user, so for anyone else it does not exist. */
  async detail(id: string, userId: string | null): Promise<EventDetail> {
    const [event] = await this.db
      .select(summaryColumns)
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(and(eq(events.id, id), visibleTo(userId)));
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
