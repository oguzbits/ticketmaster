import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  type Booking,
  BOOKING_LIMITS,
  BOOKING_STATUS,
  TRANSITION_REASON,
} from '@app/shared';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { bookings, bookingSeats, events, seats } from '../../infrastructure/database/schema.js';
import { SPAN_ATTR, SPAN_NAME, withSpan } from '../../infrastructure/tracing/index.js';
import { BOOKING_PORTS, type BookingPorts } from './adapters/booking-ports.js';
import {
  planTransition,
  storeOwnTransition,
  storeTransition,
} from './adapters/booking-transitions.js';
import { loadOwnBookings } from './adapters/load-own-bookings.js';
import { lockOwnBooking } from './adapters/lock-own-booking.js';
import {
  payBooking,
  type PayInput,
  type PaymentFlight,
  type SeatRef,
} from './adapters/pay-booking.js';
import { publishSeatChange } from './adapters/publish-seat-change.js';
import { reconcilePaymentAttempts } from './adapters/reconcile-payments.js';
import { SeatReservations } from './adapters/seat-reservations.js';
import { type BookingState, SYSTEM_ACTOR_ID } from './domain/booking-state-machine.js';
import { PAYMENT_GRACE_SECONDS } from './domain/payment-provider.js';
import { HOLD_OUTCOME, type HoldInput, type HoldResult } from './domain/seat-reservation.js';
import { ACTIVE_BOOKING_STATUSES } from './domain/seat-status.js';

/** Bookings the expiry job locks and expires per transaction. */
const EXPIRY_BATCH_SIZE = 500;

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);
  /** Payments past their claim, by idempotency key (see `payBooking`). */
  private readonly flights = new Map<string, PaymentFlight>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SeatReservations) private readonly reservations: SeatReservations,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BOOKING_PORTS) private readonly ports: BookingPorts
  ) {}

  /**
   * Holds 1..6 seats atomically under the strategy of the event; BadRequest when seatIds are
   * empty, exceed `BOOKING_LIMITS.MAX_SEATS`, or contain duplicates; NotFound when any seat is
   * not in the event or the event is another user's sandbox; Forbidden when the event has a
   * waiting room and the user holds no live admission.
   */
  async hold(input: HoldInput): Promise<HoldResult> {
    if (
      input.seatIds.length < BOOKING_LIMITS.MIN_SEATS ||
      input.seatIds.length > BOOKING_LIMITS.MAX_SEATS
    ) {
      throw new BadRequestException(
        `A booking requires between ${BOOKING_LIMITS.MIN_SEATS} and ${BOOKING_LIMITS.MAX_SEATS} seats`
      );
    }
    const orderedSeatIds = [...new Set(input.seatIds)].sort();
    if (orderedSeatIds.length !== input.seatIds.length) {
      throw new BadRequestException('Duplicate seats are not allowed');
    }
    const rows = await this.db
      .select({
        seatId: seats.id,
        strategy: events.strategy,
        sandboxUserId: events.sandboxUserId,
        waitingRoomCapacity: events.waitingRoomCapacity,
      })
      .from(seats)
      .innerJoin(events, eq(events.id, seats.eventId))
      .where(and(eq(seats.eventId, input.eventId), inArray(seats.id, orderedSeatIds)));
    const event = rows[0];
    if (
      event === undefined ||
      rows.length !== orderedSeatIds.length ||
      (event.sandboxUserId !== null && event.sandboxUserId !== input.userId)
    ) {
      throw new NotFoundException('Seat not found in this event');
    }
    if (event.waitingRoomCapacity !== null) {
      await this.ports.waitingRoom.assertAdmitted(
        input.eventId,
        input.userId,
        input.admissionToken
      );
    }
    const result = await withSpan(
      SPAN_NAME.HOLD_STRATEGY,
      () => this.reservations.hold(event.strategy, { ...input, seatIds: orderedSeatIds }),
      { attributes: { [SPAN_ATTR.STRATEGY]: event.strategy } }
    );
    this.ports.metrics.holdAttempted(event.strategy, result.outcome);
    if (result.outcome === HOLD_OUTCOME.PLACED) {
      await this.announce(
        result.bookingId,
        orderedSeatIds.map((seatId) => ({ eventId: input.eventId, seatId }))
      );
    }
    return result;
  }

  /** The caller's bookings with their seats and stored transitions, newest booking first. */
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
      .from(bookingSeats)
      .where(
        and(
          eq(bookingSeats.eventId, eventId),
          inArray(bookingSeats.status, [...ACTIVE_BOOKING_STATUSES])
        )
      )
      .groupBy(bookingSeats.seatId)
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
  async pay(input: PayInput): Promise<BookingState> {
    const { state, seats: changed } = await payBooking(
      {
        db: this.db,
        clock: this.clock,
        ports: this.ports,
        logger: this.logger,
        flights: this.flights,
      },
      input
    );
    if (changed !== null) {
      // Only the request that applied the result counts it (`changed` is null for a parallel one).
      this.ports.metrics.bookingSettled(state.status);
      await this.announce(state.id, changed);
    }
    return state;
  }

  async cancel(input: {
    bookingId: string;
    userId: string;
    requestId: string;
  }): Promise<BookingState> {
    const { state, seats: changed } = await this.db.transaction(async (tx) => {
      const {
        booking,
        paymentIdempotencyKey,
        seats: bookedSeats,
      } = await lockOwnBooking(tx, input.bookingId, input.userId);
      // A claimed key on a HELD booking means a charge may be in flight: the payment decides.
      if (booking.status === BOOKING_STATUS.HELD && paymentIdempotencyKey !== null) {
        throw new ConflictException('A payment of this booking is in progress');
      }
      const cancelled = planTransition(
        booking,
        TRANSITION_REASON.CANCELLED_BY_USER,
        input.userId,
        this.clock.now()
      );
      const stored = await storeOwnTransition(tx, input.userId, cancelled);
      await this.ports.audit.record(tx, {
        actorId: input.userId,
        action: AUDIT_ACTION.BOOKING_CANCELLED,
        subjectType: AUDIT_SUBJECT.BOOKING,
        subjectId: stored.id,
        requestId: input.requestId,
      });
      return { state: stored, seats: bookedSeats };
    });
    this.ports.metrics.bookingSettled(state.status);
    await this.announce(state.id, changed);
    return state;
  }

  /** Expires every HELD booking whose hold has passed; returns how many. Safe to run in parallel. */
  async expireHolds(now: Date): Promise<number> {
    let expired = 0;
    const graceStart = new Date(now.getTime() - PAYMENT_GRACE_SECONDS * 1000);
    for (;;) {
      const batch = await this.db.transaction(async (tx) => {
        // SKIP LOCKED: a booking another runner or a payment holds is left to them.
        const due = await tx
          .select({
            id: bookings.id,
            status: bookings.status,
            holdExpiresAt: bookings.holdExpiresAt,
            eventId: bookings.eventId,
          })
          .from(bookings)
          .where(
            and(
              eq(bookings.status, BOOKING_STATUS.HELD),
              lte(bookings.holdExpiresAt, now),
              // A claimed payment may still finish: it keeps its hold through the grace period.
              or(isNull(bookings.paymentIdempotencyKey), lte(bookings.holdExpiresAt, graceStart))
            )
          )
          .limit(EXPIRY_BATCH_SIZE)
          .for('update', { skipLocked: true });
        if (due.length === 0) return [];
        const seatRows = await tx
          .select({
            bookingId: bookingSeats.bookingId,
            eventId: bookingSeats.eventId,
            seatId: bookingSeats.seatId,
          })
          .from(bookingSeats)
          .where(
            inArray(
              bookingSeats.bookingId,
              due.map(({ id }) => id)
            )
          );
        const released: { id: string; seats: SeatRef[] }[] = [];
        for (const booking of due) {
          const result = planTransition(
            booking,
            TRANSITION_REASON.HOLD_EXPIRED,
            SYSTEM_ACTOR_ID,
            now
          );
          await storeTransition(tx, result);
          released.push({
            id: booking.id,
            seats: seatRows
              .filter(({ bookingId }) => bookingId === booking.id)
              .map(({ eventId, seatId }) => ({ eventId, seatId })),
          });
        }
        return released;
      });
      if (batch.length > 0) this.ports.metrics.bookingSettled(BOOKING_STATUS.EXPIRED, batch.length);
      await Promise.all(batch.map((b) => this.announce(b.id, b.seats)));
      expired += batch.length;
      if (batch.length < EXPIRY_BATCH_SIZE) return expired;
    }
  }

  /** Settles crashed charges and retries failed late refunds. Safe to run in parallel. */
  async reconcilePayments(
    now: Date
  ): Promise<{ settled: number; refunded: number; released: number }> {
    const { settled, refunded, released } = await reconcilePaymentAttempts(
      { db: this.db, ports: this.ports, logger: this.logger },
      now
    );
    if (settled.length > 0) {
      this.ports.metrics.bookingSettled(BOOKING_STATUS.CONFIRMED, settled.length);
      await Promise.all(
        settled.map((b) =>
          this.announce(
            b.bookingId,
            b.seatIds.map((seatId) => ({ eventId: b.eventId, seatId }))
          )
        )
      );
    }
    return { settled: settled.length, refunded, released };
  }

  /** Called after the commit: tells the viewers of the event which status each affected seat has now. */
  private async announce(bookingId: string, changed: readonly SeatRef[]): Promise<void> {
    const at = this.clock.now().toISOString();
    await Promise.all(
      changed.map((seat) =>
        publishSeatChange(
          { db: this.db, publisher: this.ports.seatChanges, logger: this.logger },
          { eventId: seat.eventId, seatId: seat.seatId, at },
          `booking ${bookingId}`
        )
      )
    );
  }
}
