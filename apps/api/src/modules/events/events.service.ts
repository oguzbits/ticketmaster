import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  type BookingStrategy,
  EVENT_LIST_LIMITS,
  type EventDetail,
  type EventListQuery,
  type EventListResponse,
  type EventSummary,
} from '@app/shared';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, gte, inArray, isNull, lte, or, type SQL, sql } from 'drizzle-orm';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import {
  isStrategyAllowed,
  UNSAFE_STRATEGY_DISABLED_MESSAGE,
} from '../../core/booking-strategy-policy.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import {
  bookingSeats,
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

function encodeEventCursor(event: Pick<EventSummary, 'startsAt' | 'id'>): string {
  return `${event.startsAt}|${event.id}`;
}

function decodeEventCursor(cursor: string): { startsAt: Date; id: string } {
  const sep = cursor.indexOf('|');
  const startsAt = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(startsAt.getTime()) || id === '') {
    throw new BadRequestException('Invalid cursor');
  }
  return { startsAt, id };
}

function isDefaultPublicQuery(userId: string | null, query: EventListQuery): boolean {
  return (
    userId === null &&
    query.q === undefined &&
    query.from === undefined &&
    query.to === undefined &&
    query.maxPriceCents === undefined &&
    query.cursor === undefined &&
    query.limit === EVENT_LIST_LIMITS.PAGE_DEFAULT
  );
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
    private readonly eventCache: EventCache,
    @Inject(APP_CONFIG)
    private readonly env: Pick<Env, 'UNSAFE_STRATEGIES_ENABLED'> = {
      UNSAFE_STRATEGIES_ENABLED: true,
    }
  ) {}

  /**
   * Unfiltered anonymous first-page reads go through `EventCache`; filtered, paginated, or
   * authenticated reads (which include the caller's sandbox events) query PostgreSQL directly.
   */
  async list(
    userId: string | null,
    query: EventListQuery = { limit: EVENT_LIST_LIMITS.PAGE_DEFAULT }
  ): Promise<EventListResponse> {
    if (isDefaultPublicQuery(userId, query)) {
      return this.eventCache.list(() => this.listFromDb(null, query));
    }
    return this.listFromDb(userId, query);
  }

  private async listFromDb(
    userId: string | null,
    query: EventListQuery
  ): Promise<EventListResponse> {
    const conditions: (SQL | undefined)[] = [visibleTo(userId)];
    if (query.q !== undefined) {
      const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(
        or(
          sql`${events.name} ilike ${pattern} escape '\\'`,
          sql`${venues.name} ilike ${pattern} escape '\\'`
        )
      );
    }
    if (query.from !== undefined) {
      conditions.push(gte(events.startsAt, new Date(query.from)));
    }
    if (query.to !== undefined) {
      conditions.push(lte(events.startsAt, new Date(query.to)));
    }
    if (query.maxPriceCents !== undefined) {
      conditions.push(
        sql`exists (select 1 from ${seats} where ${seats.eventId} = ${events.id} and ${seats.priceCents} <= ${query.maxPriceCents})`
      );
    }
    if (query.cursor !== undefined) {
      const cursor = decodeEventCursor(query.cursor);
      conditions.push(
        or(
          gt(events.startsAt, cursor.startsAt),
          and(eq(events.startsAt, cursor.startsAt), gt(events.id, cursor.id))
        )
      );
    }
    const rows = await this.db
      .select(summaryColumns)
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(and(...conditions))
      .orderBy(asc(events.startsAt), asc(events.id))
      .limit(query.limit + 1);
    const items = rows
      .slice(0, query.limit)
      .map((row) => ({ ...row, startsAt: row.startsAt.toISOString() }));
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > query.limit && last !== undefined ? encodeEventCursor(last) : null,
    };
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
    if (!isStrategyAllowed(strategy, this.env.UNSAFE_STRATEGIES_ENABLED)) {
      throw new BadRequestException(UNSAFE_STRATEGY_DISABLED_MESSAGE);
    }
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
        seatId: bookingSeats.seatId,
        status: sql<(typeof ACTIVE_BOOKING_STATUSES)[number]>`max(${bookingSeats.status})`,
      })
      .from(bookingSeats)
      .where(
        and(
          eq(bookingSeats.eventId, id),
          inArray(bookingSeats.status, [...ACTIVE_BOOKING_STATUSES])
        )
      )
      .groupBy(bookingSeats.seatId);
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
