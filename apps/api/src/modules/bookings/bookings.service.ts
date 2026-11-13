import { type Booking, BOOKING_STATUS, TRANSITION_REASON } from '@app/shared';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
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
import { SeatReservations } from './adapters/seat-reservations.js';
import { type BookingState, SYSTEM_ACTOR_ID } from './domain/booking-state-machine.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './domain/payment-provider.js';
import type { HoldInput, HoldResult } from './domain/seat-reservation.js';
import { ACTIVE_BOOKING_STATUSES } from './domain/seat-status.js';

/** Bookings the expiry job locks and expires per transaction. */
const EXPIRY_BATCH_SIZE = 500;

@Injectable()
export class BookingsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SeatReservations) private readonly reservations: SeatReservations,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider
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
    return this.reservations.hold(event.strategy, input);
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
    return this.db.transaction(async (tx) => {
      const { booking, paymentIdempotencyKey, priceCents } = await this.lockOwnBooking(
        tx,
        input.bookingId,
        input.userId
      );
      if (paymentIdempotencyKey === input.idempotencyKey) return booking;
      const now = this.clock.now();
      // Refused before the charge: another key on a settled booking, or a hold that ran out.
      const paid = planTransition(booking, TRANSITION_REASON.PAYMENT_SUCCEEDED, input.userId, now);
      await claimPaymentKey(tx, booking.id, input.idempotencyKey);
      // shortcut: the fake charge runs inside the database transaction; a real provider call moves
      // out of it with the outbox in phase 2.
      const { succeeded } = await this.payments.charge({
        bookingId: booking.id,
        amountCents: priceCents,
        idempotencyKey: input.idempotencyKey,
      });
      if (!succeeded) {
        const failed = planTransition(booking, TRANSITION_REASON.PAYMENT_FAILED, input.userId, now);
        return storeTransition(tx, failed);
      }
      const stored = await storeTransition(tx, paid);
      return storeTransition(
        tx,
        planTransition(stored, TRANSITION_REASON.CONFIRMED, input.userId, now)
      );
    });
  }

  async cancel(input: { bookingId: string; userId: string }): Promise<BookingState> {
    return this.db.transaction(async (tx) => {
      const { booking } = await this.lockOwnBooking(tx, input.bookingId, input.userId);
      const cancelled = planTransition(
        booking,
        TRANSITION_REASON.CANCELLED_BY_USER,
        input.userId,
        this.clock.now()
      );
      return storeTransition(tx, cancelled);
    });
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
          })
          .from(bookings)
          .where(and(eq(bookings.status, BOOKING_STATUS.HELD), lte(bookings.holdExpiresAt, now)))
          .limit(EXPIRY_BATCH_SIZE)
          .for('update', { skipLocked: true });
        for (const booking of due) {
          await storeTransition(
            tx,
            planTransition(booking, TRANSITION_REASON.HOLD_EXPIRED, SYSTEM_ACTOR_ID, now)
          );
        }
        return due.length;
      });
      expired += batch;
      if (batch < EXPIRY_BATCH_SIZE) return expired;
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
  }> {
    const [row] = await tx
      .select({
        id: bookings.id,
        status: bookings.status,
        holdExpiresAt: bookings.holdExpiresAt,
        paymentIdempotencyKey: bookings.paymentIdempotencyKey,
        ownerId: bookings.userId,
        priceCents: seats.priceCents,
      })
      .from(bookings)
      .innerJoin(seats, eq(seats.id, bookings.seatId))
      .where(eq(bookings.id, bookingId))
      .for('update', { of: bookings });
    if (row === undefined) throw new NotFoundException('Booking not found');
    if (row.ownerId !== userId) throw new ForbiddenException('Booking belongs to another user');
    const { id, status, holdExpiresAt, paymentIdempotencyKey, priceCents } = row;
    return { booking: { id, status, holdExpiresAt }, paymentIdempotencyKey, priceCents };
  }
}
