import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  BOOKING_STATUS,
  type BookingStatus,
  type CreateEventRequest,
  type EventSummary,
  type OrganizerEvent,
  type Venue,
  VENUE_LIST_LIMITS,
  type VenueListQuery,
  type VenueListResponse,
} from '@app/shared';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Env } from '../../config/env.js';
import {
  isStrategyAllowed,
  UNSAFE_STRATEGY_DISABLED_MESSAGE,
} from '../../core/booking-strategy-policy.js';
import type { Clock } from '../../core/clock.js';
import { type Database, DB, type Tx } from '../../infrastructure/database/database.module.js';
import {
  bookings,
  demoUsers,
  events,
  seats,
  venues,
  venueSeats,
} from '../../infrastructure/database/schema.js';
import { AuditService } from '../audit/index.js';
import { EventCache } from '../event-cache/index.js';

/** Events one owner may have; every event copies a venue's seats, so the table cannot grow unbounded. */
export const MAX_EVENTS_PER_OWNER = 20;

export const ORGANIZER_DEPS = Symbol('ORGANIZER_DEPS');

export interface OrganizerDeps {
  clock: Clock;
  audit: AuditService;
  eventCache: EventCache;
  env: Pick<Env, 'UNSAFE_STRATEGIES_ENABLED'>;
}

const VenueCursorTupleSchema = z.tuple([z.string(), z.uuid()]);

function encodeVenueCursor(venue: Pick<Venue, 'name' | 'id'>): string {
  return Buffer.from(JSON.stringify([venue.name, venue.id]), 'utf8').toString('base64url');
}

function decodeVenueCursor(cursor: string): { name: string; id: string } {
  try {
    const parsed = VenueCursorTupleSchema.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    );
    if (!parsed.success) throw new BadRequestException('Invalid cursor');
    return { name: parsed.data[0], id: parsed.data[1] };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Invalid cursor');
  }
}

@Injectable()
export class OrganizerService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ORGANIZER_DEPS) private readonly deps: OrganizerDeps
  ) {}

  /**
   * One transaction: the event and a copy of the venue's seats with their prices. The event of a
   * demo user is a sandbox event, so a visitor's event stays private to them.
   */
  async createEvent(
    input: CreateEventRequest,
    ownerId: string,
    requestId: string
  ): Promise<EventSummary> {
    if (!isStrategyAllowed(input.strategy, this.deps.env.UNSAFE_STRATEGIES_ENABLED)) {
      throw new BadRequestException(UNSAFE_STRATEGY_DISABLED_MESSAGE);
    }
    const startsAt = new Date(input.startsAt);
    if (startsAt.getTime() <= this.deps.clock.now().getTime()) {
      throw new BadRequestException('startsAt must lie in the future');
    }
    const created = await this.db.transaction((tx) =>
      this.insertEvent(tx, { input, startsAt, ownerId, requestId })
    );
    await this.deps.eventCache.invalidate(created.id);
    return created;
  }

  private async insertEvent(
    tx: Tx,
    params: {
      input: CreateEventRequest;
      startsAt: Date;
      ownerId: string;
      requestId: string;
    }
  ): Promise<EventSummary> {
    const { input, startsAt, ownerId, requestId } = params;
    await this.assertBelowCap(tx, ownerId);
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
        waitingRoomCapacity: input.waitingRoomCapacity,
        ownerId,
        sandboxUserId: demoUser === undefined ? null : ownerId,
      })
      .returning({ id: events.id });
    if (event === undefined) throw new Error('event insert returned no row');
    await this.deps.audit.record(tx, {
      actorId: ownerId,
      action: AUDIT_ACTION.EVENT_CREATED,
      subjectType: AUDIT_SUBJECT.EVENT,
      subjectId: event.id,
      requestId,
    });
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
      waitingRoomCapacity: input.waitingRoomCapacity,
    };
  }

  /** Serializes one owner's creations, so parallel requests cannot all pass the count. */
  private async assertBelowCap(tx: Tx, ownerId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerId}))`);
    const [owned] = await tx
      .select({ total: count() })
      .from(events)
      .where(eq(events.ownerId, ownerId));
    if ((owned?.total ?? 0) >= MAX_EVENTS_PER_OWNER) {
      throw new ConflictException(`At most ${MAX_EVENTS_PER_OWNER} events per organizer`);
    }
  }

  async listVenues(
    query: VenueListQuery = { limit: VENUE_LIST_LIMITS.PAGE_DEFAULT }
  ): Promise<VenueListResponse> {
    const conditions: (SQL | undefined)[] = [];
    if (query.q !== undefined) {
      const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(sql`${venues.name} ilike ${pattern} escape '\\'`);
    }
    if (query.cursor !== undefined) {
      const cursor = decodeVenueCursor(query.cursor);
      conditions.push(
        or(
          gt(venues.name, cursor.name),
          and(eq(venues.name, cursor.name), gt(venues.id, cursor.id))
        )
      );
    }
    const rows = await this.db
      .select({ id: venues.id, name: venues.name, seatCount: count(venueSeats.venueId) })
      .from(venues)
      .leftJoin(venueSeats, eq(venueSeats.venueId, venues.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(venues.id)
      .orderBy(asc(venues.name), asc(venues.id))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > query.limit && last !== undefined ? encodeVenueCursor(last) : null,
    };
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
        waitingRoomCapacity: events.waitingRoomCapacity,
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
