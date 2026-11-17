import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  OUTBOX_MESSAGE_TYPE,
  PAYMENT_ATTEMPT_STATUS,
  type QueueMessage,
  ROLE,
  SIMULATION_STATUS,
  type SimulationMetrics,
  TRANSITION_REASON,
} from '@app/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
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
export const paymentAttemptStatusEnum = pgEnum('payment_attempt_status', PAYMENT_ATTEMPT_STATUS);
export const userRoleEnum = pgEnum('user_role', ROLE);
export const simulationStatusEnum = pgEnum('simulation_status', SIMULATION_STATUS);
export const outboxMessageTypeEnum = pgEnum('outbox_message_type', OUTBOX_MESSAGE_TYPE);
export const auditActionEnum = pgEnum('audit_action', AUDIT_ACTION);
export const auditSubjectEnum = pgEnum('audit_subject', AUDIT_SUBJECT);

// The index predicate is DDL, so the values are written into it instead of passed as parameters.
const literal = (value: string) => sql.raw(`'${value}'`);
const ACTIVE_STATUSES = sql.join(
  [BOOKING_STATUS.HELD, BOOKING_STATUS.PAID, BOOKING_STATUS.CONFIRMED].map(literal),
  sql`, `
);

/** A seat template: the seats of a hall, copied onto every event held there. */
export const venues = pgTable(
  'venues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
  },
  (t) => [index('venues_name_id_idx').on(t.name, t.id)]
);

export const venueSeats = pgTable(
  'venue_seats',
  {
    venueId: uuid('venue_id')
      .notNull()
      .references(() => venues.id),
    section: text('section').notNull(),
    row: integer('row').notNull(),
    number: integer('number').notNull(),
    // Copied to the seats of every event held in the venue. Nullable: added in the expand step, the
    // seed fills it on deploy; a seat without a price makes event creation fail (not null on seats).
    priceCents: integer('price_cents'),
  },
  (t) => [primaryKey({ columns: [t.venueId, t.section, t.row, t.number] })]
);

export const events = pgTable(
  'events',
  {
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
    // Null: no waiting room; a number is the capacity (live admissions at once).
    waitingRoomCapacity: integer('waiting_room_capacity'),
  },
  (t) => [
    check('events_waiting_room_capacity_positive', sql`${t.waitingRoomCapacity} > 0`),
    index('events_starts_at_id_idx').on(t.startsAt, t.id),
  ]
);

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
  (t) => [
    unique('seats_event_position_uq').on(t.eventId, t.section, t.row, t.number),
    index('seats_event_price_idx').on(t.eventId, t.priceCents),
  ]
);

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    // Copied from the event; per-seat active uniqueness is enforced on `booking_seats`.
    strategy: bookingStrategyEnum('strategy').notNull(),
    status: bookingStatusEnum('status').notNull(),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }).notNull(),
    // Idempotency key of the payment request (see the payment contract).
    paymentIdempotencyKey: text('payment_idempotency_key').unique(),
    // When the key was claimed; the payment is planned at this time, however late a retry runs.
    paymentClaimedAt: timestamp('payment_claimed_at', { withTimezone: true }),
    // When the worker stored the ticket PDF; null until then (and for bookings before the feature).
    ticketReadyAt: timestamp('ticket_ready_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Serves the expiry job: HELD bookings whose hold has passed.
    index('bookings_status_hold_expires_idx').on(t.status, t.holdExpiresAt),
    // Serves booking lookups per event and status.
    index('bookings_event_status_idx').on(t.eventId, t.status),
  ]
);

export const bookingSeats = pgTable(
  'booking_seats',
  {
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    seatId: uuid('seat_id')
      .notNull()
      .references(() => seats.id, { onDelete: 'cascade' }),
    // Copied from the booking so the partial unique index below can exclude NAIVE.
    strategy: bookingStrategyEnum('strategy').notNull(),
    // Kept synchronized with `bookings.status` on every hold and transition.
    status: bookingStatusEnum('status').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bookingId, t.seatId] }),
    index('booking_seats_seat_idx').on(t.seatId),
    index('booking_seats_event_status_idx').on(t.eventId, t.status),
    // Defense in depth: the database refuses a second active booking of a seat, except in NAIVE.
    uniqueIndex('booking_seats_active_seat_uidx')
      .on(t.seatId)
      .where(
        sql`${t.status} in (${ACTIVE_STATUSES}) and ${t.strategy} <> ${literal(BOOKING_STRATEGY.NAIVE)}`
      ),
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

/** A throw-away Keycloak user of the demo login; the worker deletes it and its data after `expires_at`. */
export const demoUsers = pgTable(
  'demo_users',
  {
    // The `sub` of the user's tokens, so also `events.sandbox_user_id` and `bookings.user_id`.
    userId: uuid('user_id').primaryKey(),
    role: userRoleEnum('role').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Serves the cleanup job: users whose time has passed.
  (t) => [index('demo_users_expires_at_idx').on(t.expiresAt)]
);

/** One rush of the simulator on its own sandbox event; the metrics are filled when the run ends. */
export const simulationRuns = pgTable(
  'simulation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    strategy: bookingStrategyEnum('strategy').notNull(),
    buyers: integer('buyers').notNull(),
    seats: integer('seats').notNull(),
    status: simulationStatusEnum('status').notNull(),
    metrics: jsonb('metrics').$type<SimulationMetrics>(),
    // The admin who started the run.
    startedBy: uuid('started_by').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // W3C trace context of the request that started the run; the worker continues it, so the run's
    // spans join that trace. Null for runs older than the column and for runs started outside a trace.
    traceparent: text('traceparent'),
  },
  // Serves the cap query: runs that are still active and started within the timeout.
  (t) => [index('simulation_runs_status_started_at_idx').on(t.status, t.startedAt)]
);

/**
 * A message that goes to the queue, written in the transaction of the state change it announces.
 * The relay in the worker sends it and sets `published_at`. The ID is the message ID: the
 * idempotency key of every consumer.
 */
export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey(),
    type: outboxMessageTypeEnum('type').notNull(),
    // The whole message, as the queue carries it.
    payload: jsonb('payload').$type<QueueMessage>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    // Failed sends so far; `last_error` holds the error name of the latest one, never a message text.
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    // W3C trace context of the change that wrote the row; null for rows older than the column or
    // written outside a trace. The relay continues it so a booking is one trace through the queue.
    traceparent: text('traceparent'),
  },
  // Serves the relay (oldest unpublished first) and the readiness check; stays small however many
  // rows are published.
  (t) => [
    index('outbox_messages_unpublished_idx')
      .on(t.createdAt)
      .where(sql`${t.publishedAt} is null`),
    // Defense in depth: the database refuses a second confirmation message of one booking.
    uniqueIndex('outbox_messages_confirmed_booking_uidx')
      .on(sql`(${t.payload}->>'bookingId')`)
      .where(sql`${t.type} = ${literal(OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED)}`),
  ]
);

/** The messages a consumer has handled: the primary key makes a second delivery a no-op. */
export const processedMessages = pgTable(
  'processed_messages',
  {
    consumer: text('consumer').notNull(),
    messageId: uuid('message_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.messageId] })]
);

/**
 * Who did what: one row per audited state change, written in the transaction of the change by
 * `AuditService.record` and never updated or deleted. IDs only. No foreign keys: a row outlives a
 * deleted demo user or event. The identity `id` is the keyset cursor of the admin route.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    actorId: uuid('actor_id').notNull(),
    action: auditActionEnum('action').notNull(),
    subjectType: auditSubjectEnum('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    requestId: text('request_id').notNull(),
  },
  // Serve the filtered, newest-first pages of the admin route.
  (t) => [
    index('audit_log_actor_id_id_idx').on(t.actorId, t.id),
    index('audit_log_action_id_idx').on(t.action, t.id),
  ]
);

/**
 * Payment attempts tracked across the 3-step charge pipeline (claim -> charge -> apply/refund).
 * Allows the worker reconciliation job to settle crashed charges and retry failed late refunds.
 */
export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    amountCents: integer('amount_cents').notNull(),
    status: paymentAttemptStatusEnum('status').notNull(),
    requestId: text('request_id').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_attempts_reconcile_idx').on(t.status, t.updatedAt),
    index('payment_attempts_booking_idx').on(t.bookingId),
  ]
);
