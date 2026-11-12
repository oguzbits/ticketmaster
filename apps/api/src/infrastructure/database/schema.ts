import { BOOKING_STATUS, BOOKING_STRATEGY, TRANSITION_REASON } from '@app/shared';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const bookingStrategyEnum = pgEnum('booking_strategy', BOOKING_STRATEGY);
export const bookingStatusEnum = pgEnum('booking_status', BOOKING_STATUS);
export const transitionReasonEnum = pgEnum('transition_reason', TRANSITION_REASON);

// The index predicate is DDL, so the values are written into it instead of passed as parameters.
const literal = (value: string) => sql.raw(`'${value}'`);
const ACTIVE_STATUSES = sql.join(
  [BOOKING_STATUS.HELD, BOOKING_STATUS.PAID, BOOKING_STATUS.CONFIRMED].map(literal),
  sql`, `
);

/** A seat template: the seats of a hall, copied onto every event held there. */
export const venues = pgTable('venues', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
});

export const venueSeats = pgTable(
  'venue_seats',
  {
    venueId: uuid('venue_id')
      .notNull()
      .references(() => venues.id),
    section: text('section').notNull(),
    row: integer('row').notNull(),
    number: integer('number').notNull(),
  },
  (t) => [primaryKey({ columns: [t.venueId, t.section, t.row, t.number] })]
);

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  venueId: uuid('venue_id')
    .notNull()
    .references(() => venues.id),
  name: text('name').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  strategy: bookingStrategyEnum('strategy').notNull(),
  ownerId: uuid('owner_id').notNull(),
  // Set for a demo user's private event; null for a public one.
  sandboxUserId: uuid('sandbox_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const seats = pgTable(
  'seats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    section: text('section').notNull(),
    row: integer('row').notNull(),
    number: integer('number').notNull(),
    priceCents: integer('price_cents').notNull(),
    // Compared and incremented by the optimistic strategy.
    version: integer('version').notNull().default(0),
  },
  (t) => [unique('seats_event_position_uq').on(t.eventId, t.section, t.row, t.number)]
);

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    seatId: uuid('seat_id')
      .notNull()
      .references(() => seats.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    // Copied from the event so the partial index below can exclude the comparison mode.
    strategy: bookingStrategyEnum('strategy').notNull(),
    status: bookingStatusEnum('status').notNull(),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }).notNull(),
    // Idempotency key of the payment request (see the payment contract).
    paymentIdempotencyKey: text('payment_idempotency_key').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bookings_seat_idx').on(t.seatId),
    // Defense in depth: the database refuses a second active booking of a seat, except in NAIVE.
    uniqueIndex('bookings_active_seat_uidx')
      .on(t.seatId)
      .where(
        sql`${t.status} in (${ACTIVE_STATUSES}) and ${t.strategy} <> ${literal(BOOKING_STRATEGY.NAIVE)}`
      ),
    // Serves the expiry job: HELD bookings whose hold has passed.
    index('bookings_status_hold_expires_idx').on(t.status, t.holdExpiresAt),
  ]
);

export const bookingTransitions = pgTable('booking_transitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id, { onDelete: 'cascade' }),
  fromStatus: bookingStatusEnum('from_status'),
  toStatus: bookingStatusEnum('to_status').notNull(),
  reason: transitionReasonEnum('reason').notNull(),
  actorId: uuid('actor_id'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
