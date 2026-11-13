import { type Booking, BOOKING_STATUS, type BookingStatus, TRANSITION_REASON } from '@app/shared';
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, lte, type SQL, sql } from 'drizzle-orm';

import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import {
  bookings,
  bookingTransitions,
  events,
  seats,
} from '../../infrastructure/database/schema.js';
import {
  claimPaymentKey,
  planTransition,
  storeTransition,
} from './adapters/booking-transitions.js';
import type { Tx } from './adapters/insert-hold.js';
import { publishSeatChange } from './adapters/publish-seat-change.js';
import { SeatReservations } from './adapters/seat-reservations.js';
import { BOOKING_PORTS, type BookingPorts } from './domain/booking-ports.js';
import { type BookingState, SYSTEM_ACTOR_ID } from './domain/booking-state-machine.js';
import { HOLD_OUTCOME, type HoldInput, type HoldResult } from './domain/seat-reservation.js';
import { ACTIVE_BOOKING_STATUSES } from './domain/seat-status.js';

/** Bookings the expiry job locks and expires per transaction. */
const EXPIRY_BATCH_SIZE = 500;

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SeatReservations) private readonly reservations: SeatReservations,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BOOKING_PORTS) private readonly ports: BookingPorts
  ) {}

  /**
   * Holds the seat under the strategy of its event; NotFound when the seat is not in the event or
   * the event is the sandbox of another user.
   */
  async hold(input: HoldInput): Promise<HoldResult> {
    const [event] = await this.db
      .select({ strategy: events.strategy, sandboxUserId: events.sandboxUserId })
      .from(seats)
      .innerJoin(events, eq(events.id, seats.eventId))
      .where(and(eq(seats.id, input.seatId), eq(seats.eventId, input.eventId)));
    if (
      event === undefined ||
      (event.sandboxUserId !== null && event.sandboxUserId !== input.userId)
    ) {
      throw new NotFoundException('Seat not found in this event');
    }
    const result = await this.reservations.hold(event.strategy, input);
    if (result.outcome === HOLD_OUTCOME.PLACED) {
      await this.announce(result.bookingId, input);
    }
    return result;
  }

  /** The caller's bookings with their stored transitions, newest booking first. */
  listOwn(userId: string): Promise<Booking[]> {
    return this.loadOwn(userId);
  }

  /** One booking of the caller; NotFound when it does not exist or belongs to someone else. */
  async getOwn(bookingId: string, userId: string): Promise<Booking> {
    const [booking] = await this.loadOwn(userId, eq(bookings.id, bookingId));
    if (booking === undefined) throw new NotFoundException('Booking not found');
    return booking;
  }

  /** Σ (active bookings per seat − 1) over the seats of the event. */
  async countDoubleBookings(eventId: string): Promise<number> {
    const perSeat = this.db
      .select({ n: count().as('n') })
      .from(bookings)
      .where(
        and(eq(bookings.eventId, eventId), inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]))
      )
      .groupBy(bookings.seatId)
      .as('per_seat');
    const [row] = await this.db
      .select({ doubles: sql<number>`coalesce(sum(${perSeat.n} - 1), 0)::int` })
      .from(perSeat);
    if (row === undefined) throw new Error('double-booking count returned no row');
    return row.doubles;
  }

  /**
   * Charges the held booking once per idempotency key: the same key again returns the stored
   * result (CONFIRMED or CANCELLED) without a second charge.
   */
  async pay(input: {
    bookingId: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<BookingState> {
    const { state, seat } = await this.db.transaction(async (tx) => {
      const { booking, paymentIdempotencyKey, priceCents, seat } = await this.lockOwnBooking(
        tx,
        input.bookingId,
        input.userId
      );
      // The same key again: the stored result, nothing changes, nothing to announce.
      if (paymentIdempotencyKey === input.idempotencyKey) return { state: booking, seat: null };
      const now = this.clock.now();
      // Refused before the charge: another key on a settled booking, or a hold that ran out.
      const paid = planTransition(booking, TRANSITION_REASON.PAYMENT_SUCCEEDED, input.userId, now);
      await claimPaymentKey(tx, booking.id, input.idempotencyKey);
      // shortcut: the fake charge runs inside the database transaction; a real provider call moves
      // out of it with the outbox in phase 2.
      const { succeeded } = await this.ports.payments.charge({
        bookingId: booking.id,
        amountCents: priceCents,
        idempotencyKey: input.idempotencyKey,
      });
      if (!succeeded) {
        const failed = planTransition(booking, TRANSITION_REASON.PAYMENT_FAILED, input.userId, now);
        return { state: await storeTransition(tx, failed), seat };
      }
      const stored = await storeTransition(tx, paid);
      const confirmed = await storeTransition(
        tx,
        planTransition(stored, TRANSITION_REASON.CONFIRMED, input.userId, now)
      );
      return { state: confirmed, seat };
    });
    if (seat !== null) await this.announce(state.id, seat);
    return state;
  }

  async cancel(input: { bookingId: string; userId: string }): Promise<BookingState> {
    const { state, seat } = await this.db.transaction(async (tx) => {
      const { booking, seat } = await this.lockOwnBooking(tx, input.bookingId, input.userId);
      const cancelled = planTransition(
        booking,
        TRANSITION_REASON.CANCELLED_BY_USER,
        input.userId,
        this.clock.now()
      );
      return { state: await storeTransition(tx, cancelled), seat };
    });
    await this.announce(state.id, seat);
    return state;
  }

  /** Expires every HELD booking whose hold has passed; returns how many. Safe to run in parallel. */
  async expireHolds(now: Date): Promise<number> {
    let expired = 0;
    for (;;) {
      const batch = await this.db.transaction(async (tx) => {
        // SKIP LOCKED: a booking another runner or a payment holds is left to them.
        const due = await tx
          .select({
            id: bookings.id,
            status: bookings.status,
            holdExpiresAt: bookings.holdExpiresAt,
            eventId: bookings.eventId,
            seatId: bookings.seatId,
          })
          .from(bookings)
          .where(and(eq(bookings.status, BOOKING_STATUS.HELD), lte(bookings.holdExpiresAt, now)))
          .limit(EXPIRY_BATCH_SIZE)
          .for('update', { skipLocked: true });
        const released: { id: string; status: BookingStatus; eventId: string; seatId: string }[] =
          [];
        for (const booking of due) {
          const result = planTransition(
            booking,
            TRANSITION_REASON.HOLD_EXPIRED,
            SYSTEM_ACTOR_ID,
            now
          );
          await storeTransition(tx, result);
          released.push({ ...booking, status: result.booking.status });
        }
        return released;
      });
      await Promise.all(batch.map((b) => this.announce(b.id, b)));
      expired += batch.length;
      if (batch.length < EXPIRY_BATCH_SIZE) return expired;
    }
  }

  private async loadOwn(userId: string, extra?: SQL): Promise<Booking[]> {
    const rows = await this.db
      .select({
        id: bookings.id,
        eventId: bookings.eventId,
        seatId: bookings.seatId,
        status: bookings.status,
        holdExpiresAt: bookings.holdExpiresAt,
        section: seats.section,
        row: seats.row,
        number: seats.number,
      })
      .from(bookings)
      .innerJoin(seats, eq(seats.id, bookings.seatId))
      .where(and(eq(bookings.userId, userId), extra))
      .orderBy(desc(bookings.createdAt));
    if (rows.length === 0) return [];
    // The steps of one payment share a timestamp; the status enum order (HELD < PAID < CONFIRMED)
    // keeps them newest first.
    const stored = await this.db
      .select()
      .from(bookingTransitions)
      .where(
        inArray(
          bookingTransitions.bookingId,
          rows.map(({ id }) => id)
        )
      )
      .orderBy(desc(bookingTransitions.at), desc(bookingTransitions.toStatus));
    return rows.map(({ section, row, number, holdExpiresAt, ...booking }) => ({
      ...booking,
      holdExpiresAt: holdExpiresAt.toISOString(),
      seat: { section, row, number },
      transitions: stored
        .filter(({ bookingId }) => bookingId === booking.id)
        .map(({ fromStatus, toStatus, reason, at }) => ({
          fromStatus,
          toStatus,
          reason,
          at: at.toISOString(),
        })),
    }));
  }

  /** Locks the booking row for the transaction; unknown is NotFound, someone else's is Forbidden. */
  private async lockOwnBooking(
    tx: Tx,
    bookingId: string,
    userId: string
  ): Promise<{
    booking: BookingState;
    paymentIdempotencyKey: string | null;
    priceCents: number;
    seat: { eventId: string; seatId: string };
  }> {
    const [row] = await tx
      .select({
        id: bookings.id,
        status: bookings.status,
        holdExpiresAt: bookings.holdExpiresAt,
        paymentIdempotencyKey: bookings.paymentIdempotencyKey,
        ownerId: bookings.userId,
        eventId: bookings.eventId,
        seatId: bookings.seatId,
        priceCents: seats.priceCents,
      })
      .from(bookings)
      .innerJoin(seats, eq(seats.id, bookings.seatId))
      .where(eq(bookings.id, bookingId))
      .for('update', { of: bookings });
    if (row === undefined) throw new NotFoundException('Booking not found');
    if (row.ownerId !== userId) throw new ForbiddenException('Booking belongs to another user');
    const { id, status, holdExpiresAt, paymentIdempotencyKey, priceCents, eventId, seatId } = row;
    return {
      booking: { id, status, holdExpiresAt },
      paymentIdempotencyKey,
      priceCents,
      seat: { eventId, seatId },
    };
  }

  /** Called after the commit: tells the viewers of the event which status the seat has now. */
  private announce(bookingId: string, seat: { eventId: string; seatId: string }): Promise<void> {
    return publishSeatChange(
      { db: this.db, publisher: this.ports.seatChanges, logger: this.logger },
      { eventId: seat.eventId, seatId: seat.seatId, at: this.clock.now().toISOString() },
      `booking ${bookingId}`
    );
  }
}
