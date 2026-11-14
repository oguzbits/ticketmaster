import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  type BookingStrategy,
  type EventDetail,
  type EventSummary,
} from '@app/shared';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';

import { type Database, DB } from '../../infrastructure/database/database.module.js';
import {
  bookings,
  demoUsers,
  events,
  seats,
  venues,
} from '../../infrastructure/database/schema.js';
import { AuditService } from '../audit/index.js';
import { ACTIVE_BOOKING_STATUSES, seatStatusOf } from '../bookings/index.js';
import { EventCache, type EventLayout } from '../event-cache/index.js';

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
  waitingRoomCapacity: events.waitingRoomCapacity,
};

@Injectable()
export class EventsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly eventCache: EventCache
  ) {}

  /** Public events from the cache, plus the caller's own sandbox events straight from the database. */
  async list(userId: string | null): Promise<EventSummary[]> {
    const publicEvents = await this.eventCache.list(() =>
      this.summaries(isNull(events.sandboxUserId))
    );
    if (userId === null) return publicEvents;
    const own = await this.summaries(eq(events.sandboxUserId, userId));
    return [...publicEvents, ...own].sort(
      (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)
    );
  }

  private async summaries(scope: SQL): Promise<EventSummary[]> {
    const rows = await this.db
      .select(summaryColumns)
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(scope)
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

  /**
   * Admin switch: later holds use the new strategy, existing bookings keep their own. The demo
   * login hands out admin tokens, so a demo admin may only switch their own sandbox events; a
   * regular admin switches public events. Anything else does not exist for the caller (NotFound).
   */
  async setStrategy(
    id: string,
    strategy: BookingStrategy,
    callerId: string,
    requestId: string
  ): Promise<EventSummary> {
    const [demoUser] = await this.db
      .select({ userId: demoUsers.userId })
      .from(demoUsers)
      .where(eq(demoUsers.userId, callerId));
    const scope =
      demoUser === undefined ? isNull(events.sandboxUserId) : eq(events.sandboxUserId, callerId);
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(events)
        .set({ strategy })
        .where(and(eq(events.id, id), scope))
        .returning({ id: events.id });
      if (updated === undefined) throw new NotFoundException('Event not found');
      await this.audit.record(tx, {
        actorId: callerId,
        action: AUDIT_ACTION.EVENT_STRATEGY_SWITCHED,
        subjectType: AUDIT_SUBJECT.EVENT,
        subjectId: id,
        requestId,
      });
    });
    await this.eventCache.invalidate(id);
    const [event] = await this.db
      .select(summaryColumns)
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(eq(events.id, id));
    if (event === undefined) throw new NotFoundException('Event not found');
    return { ...event, startsAt: event.startsAt.toISOString() };
  }

  /**
   * A sandbox event is private to its demo user, so for anyone else it does not exist. The layout
   * of a public event comes from the cache; a sandbox event and every seat status are read live.
   */
  async detail(id: string, userId: string | null): Promise<EventDetail> {
    const layout =
      (await this.eventCache.detail(id, () => this.layout(id, isNull(events.sandboxUserId)))) ??
      (userId === null ? null : await this.layout(id, eq(events.sandboxUserId, userId)));
    if (layout === null) throw new NotFoundException('Event not found');

    // One row per seat with an active booking: the NAIVE comparison strategy can hold several, so
    // the furthest one wins (enum order: HELD < PAID < CONFIRMED).
    const active = await this.db
      .select({
        seatId: bookings.seatId,
        status: sql<(typeof ACTIVE_BOOKING_STATUSES)[number]>`max(${bookings.status})`,
      })
      .from(bookings)
      .where(and(eq(bookings.eventId, id), inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES])))
      .groupBy(bookings.seatId);
    const statusOf = new Map(active.map(({ seatId, status }) => [seatId, status]));
    return {
      ...layout,
      seats: layout.seats.map((seat) => ({
        ...seat,
        status: seatStatusOf(statusOf.get(seat.id) ?? null),
      })),
    };
  }

  /** The event with its seats, without status; null when no event matches `scope`. */
  private async layout(id: string, scope: SQL): Promise<EventLayout | null> {
    const [event] = await this.db
      .select(summaryColumns)
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(and(eq(events.id, id), scope));
    if (event === undefined) return null;
    const rows = await this.db
      .select({
        id: seats.id,
        section: seats.section,
        row: seats.row,
        number: seats.number,
        priceCents: seats.priceCents,
      })
      .from(seats)
      .where(eq(seats.eventId, id))
      .orderBy(asc(seats.section), asc(seats.row), asc(seats.number));
    return { ...event, startsAt: event.startsAt.toISOString(), seats: rows };
  }
}
