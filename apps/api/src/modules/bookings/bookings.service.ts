import { type Booking, BOOKING_STATUS, type BookingStatus, TRANSITION_REASON } from '@app/shared';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, eq, inArray, lte, sql } from 'drizzle-orm';

import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB, type Tx } from '../../infrastructure/database/database.module.js';
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
import { loadOwnBookings } from './adapters/load-own-bookings.js';
import { publishSeatChange } from './adapters/publish-seat-change.js';
import { SeatReservations } from './adapters/seat-reservations.js';
import { BOOKING_PORTS, type BookingPorts } from './domain/booking-ports.js';
import { type BookingState, SYSTEM_ACTOR_ID } from './domain/booking-state-machine.js';
import { HOLD_OUTCOME, type HoldInput, type HoldResult } from './domain/seat-reservation.js';
import { ACTIVE_BOOKING_STATUSES } from './domain/seat-status.js';

type SeatRef = { eventId: string; seatId: string };

/** Bookings the expiry job locks and expires per transaction. */
const EXPIRY_BATCH_SIZE = 500;

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);
  /** Payments past their claim, by idempotency key (see `pay`). */
  private readonly flights = new Map<
    string,
    Promise<{ state: BookingState; seat: SeatRef | null }>
  >();

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
    return loadOwnBookings(this.db, userId);
  }

  /** One booking of the caller; NotFound when it does not exist or belongs to someone else. */
  async getOwn(bookingId: string, userId: string): Promise<Booking> {
    const [booking] = await loadOwnBookings(this.db, userId, eq(bookings.id, bookingId));
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
   * result (CONFIRMED or CANCELLED) without a second charge. Three steps, so that no database
   * transaction (and no row lock) stays open while the provider answers:
   * 1. claim: lock the booking, refuse what cannot be paid, store the key (commit);
   * 2. charge: call the provider with the key, outside any transaction;
   * 3. apply: lock the booking again, re-read its status and store the result.
   * A crash after step 1 or 2 leaves the key claimed on a HELD booking: the retry with the same key
   * repeats the charge (the provider answers a repeated key alike) and applies the result.
   */
  async pay(input: {
    bookingId: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<BookingState> {
    const claim = await this.claimPayment(input);
    if (claim.settled !== null) return claim.settled;
    // Single flight per process: parallel requests with one key (the claim is theirs, the
    // ownership was checked above) share one charge and one apply.
    // shortcut: across instances each one may call the provider (it answers a repeated key alike)
    // and the re-read in the apply step lets the first win; a distributed lock if a provider needs it.
    const running = this.flights.get(input.idempotencyKey);
    if (running !== undefined) return (await running).state;
    const flight = this.chargeAndApply(input, claim).finally(() => {
      this.flights.delete(input.idempotencyKey);
    });
    this.flights.set(input.idempotencyKey, flight);
    const { state, seat } = await flight;
    if (seat !== null) await this.announce(state.id, seat);
    return state;
  }

  /** Step 1: either the stored result of a settled payment, or the claim to charge. */
  private claimPayment(input: {
    bookingId: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<
    { settled: BookingState } | { settled: null; amountCents: number; seat: SeatRef; now: Date }
  > {
    return this.db.transaction(async (tx) => {
      const { booking, paymentIdempotencyKey, priceCents, seat } = await this.lockOwnBooking(
        tx,
        input.bookingId,
        input.userId
      );
      const sameKey = paymentIdempotencyKey === input.idempotencyKey;
      // The same key on a booking that left HELD: the stored result, nothing to charge or announce.
      if (sameKey && booking.status !== BOOKING_STATUS.HELD) return { settled: booking };
      const now = this.clock.now();
      // Refused before the charge: another key on a settled booking, or a hold that ran out.
      planTransition(booking, TRANSITION_REASON.PAYMENT_SUCCEEDED, input.userId, now);
      if (!sameKey) {
        // Another key is already being charged for this booking.
        if (paymentIdempotencyKey !== null) {
          throw new ConflictException('Another payment of this booking is in progress');
        }
        await claimPaymentKey(tx, booking.id, input.idempotencyKey);
      }
      return { settled: null, amountCents: priceCents, seat, now };
    });
  }

  /** Steps 2 and 3. */
  private async chargeAndApply(
    input: { bookingId: string; userId: string; idempotencyKey: string },
    claim: { amountCents: number; seat: SeatRef; now: Date }
  ): Promise<{ state: BookingState; seat: SeatRef | null }> {
    const { succeeded } = await this.ports.payments.charge({
      bookingId: input.bookingId,
      amountCents: claim.amountCents,
      idempotencyKey: input.idempotencyKey,
    });
    return this.db.transaction(async (tx) => {
      // Locked and read again: the booking may have changed while the provider was working.
      const { booking } = await this.lockOwnBooking(tx, input.bookingId, input.userId);
      if (booking.status !== BOOKING_STATUS.HELD) {
        // A parallel request of this key applied the result first: its answer stands.
        if (await this.paymentApplied(tx, booking.id)) return { state: booking, seat: null };
        // No refund in this phase (backlog): the charge went through, the booking did not.
        this.logger.warn(
          `payment of booking ${booking.id} finished while the booking was ${booking.status}; not applied`
        );
        throw new ConflictException(`Booking is ${booking.status}, the payment was not applied`);
      }
      // Planned at the time of the claim: a hold that was valid then may finish inside the grace.
      if (!succeeded) {
        const failed = planTransition(
          booking,
          TRANSITION_REASON.PAYMENT_FAILED,
          input.userId,
          claim.now
        );
        return { state: await storeTransition(tx, failed), seat: claim.seat };
      }
      const paid = planTransition(
        booking,
        TRANSITION_REASON.PAYMENT_SUCCEEDED,
        input.userId,
        claim.now
      );
      const stored = await storeTransition(tx, paid);
      const confirmed = await storeTransition(
        tx,
        planTransition(stored, TRANSITION_REASON.CONFIRMED, input.userId, claim.now)
      );
      return { state: confirmed, seat: claim.seat };
    });
  }

  private async paymentApplied(tx: Tx, bookingId: string): Promise<boolean> {
    const [applied] = await tx
      .select({ id: bookingTransitions.id })
      .from(bookingTransitions)
      .where(
        and(
          eq(bookingTransitions.bookingId, bookingId),
          inArray(bookingTransitions.reason, [
            TRANSITION_REASON.PAYMENT_SUCCEEDED,
            TRANSITION_REASON.PAYMENT_FAILED,
          ])
        )
      )
      .limit(1);
    return applied !== undefined;
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
