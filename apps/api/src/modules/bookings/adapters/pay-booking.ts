import { randomUUID } from 'node:crypto';

import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  BOOKING_STATUS,
  OUTBOX_MESSAGE_TYPE,
  TRANSITION_REASON,
  type TransitionReason,
} from '@app/shared';
import { ConflictException, type Logger } from '@nestjs/common';

import type { Clock } from '../../../core/clock.js';
import type { Database } from '../../../infrastructure/database/database.module.js';
import type { BookingState } from '../domain/booking-state-machine.js';
import type { BookingPorts } from './booking-ports.js';
import {
  claimPaymentKey,
  paymentApplied,
  planTransition,
  storeOwnTransition,
} from './booking-transitions.js';
import { chargeOrRelease } from './charge-or-release.js';
import { lockOwnBooking } from './lock-own-booking.js';
import { refundLateCharge } from './refund-late-charge.js';

export type SeatRef = { eventId: string; seatId: string };
export type PaymentFlight = Promise<{ state: BookingState; seat: SeatRef | null }>;

export interface PayInput {
  bookingId: string;
  userId: string;
  idempotencyKey: string;
  requestId: string;
}

export interface PayBookingDeps {
  db: Database;
  clock: Clock;
  ports: BookingPorts;
  logger: Logger;
  flights: Map<string, PaymentFlight>;
}

/**
 * Charges the held booking once per idempotency key: the same key again returns the stored
 * result (CONFIRMED or CANCELLED) without a second charge. Three steps, so that no database
 * transaction (and no row lock) stays open while the provider answers:
 * 1. claim: lock the booking, refuse what cannot be paid, store the key (commit);
 * 2. charge: call the provider with the key, outside any transaction;
 * 3. apply: lock the booking again, re-read its status and store the result.
 * Returns `seat` only for the request that actually applied the transition so callers count
 * metrics and publish seat changes once.
 */
export async function payBooking(
  deps: PayBookingDeps,
  input: PayInput
): Promise<{ state: BookingState; seat: SeatRef | null }> {
  const claim = await claimPayment(deps.db, deps.clock, input);
  if (claim.settled !== null) return { state: claim.settled, seat: null };
  // Single flight per process: parallel requests with one key (ownership is checked above) share
  // one charge and one apply. shortcut: across instances each may call the provider (it answers a
  // repeated key alike) and the re-read in the apply step lets the first win; a lock if needed.
  const running = deps.flights.get(input.idempotencyKey);
  if (running !== undefined) return { state: (await running).state, seat: null };
  const flight = chargeAndApply(deps, input, claim).finally(() => {
    deps.flights.delete(input.idempotencyKey);
  });
  deps.flights.set(input.idempotencyKey, flight);
  return flight;
}

/** Step 1: either the stored result of a settled payment, or the claim to charge. */
async function claimPayment(
  db: Database,
  clock: Clock,
  input: PayInput
): Promise<
  { settled: BookingState } | { settled: null; amountCents: number; seat: SeatRef; claimedAt: Date }
> {
  return db.transaction(async (tx) => {
    const { booking, paymentIdempotencyKey, paymentClaimedAt, priceCents, seat } =
      await lockOwnBooking(tx, input.bookingId, input.userId);
    const sameKey = paymentIdempotencyKey === input.idempotencyKey;
    if (sameKey && booking.status !== BOOKING_STATUS.HELD) {
      // The same key on a booking that left HELD: its stored result, or 409 if it was never paid.
      if (await paymentApplied(tx, booking.id)) return { settled: booking };
      throw new ConflictException(`Booking is ${booking.status}, the payment was not applied`);
    }
    // A retry keeps the first claim time: the hold was valid then and may finish inside the grace.
    const claimedAt = sameKey && paymentClaimedAt !== null ? paymentClaimedAt : clock.now();
    // Refused before the charge: another key on a settled booking, or a hold that ran out.
    planTransition(booking, TRANSITION_REASON.PAYMENT_SUCCEEDED, input.userId, claimedAt);
    if (!sameKey) {
      if (paymentIdempotencyKey !== null) {
        throw new ConflictException('Another payment of this booking is in progress');
      }
      await claimPaymentKey(tx, booking.id, input.idempotencyKey, claimedAt);
    }
    return { settled: null, amountCents: priceCents, seat, claimedAt };
  });
}

/** Steps 2 and 3. */
async function chargeAndApply(
  deps: Omit<PayBookingDeps, 'clock' | 'flights'>,
  input: PayInput,
  claim: { amountCents: number; seat: SeatRef; claimedAt: Date }
): Promise<{ state: BookingState; seat: SeatRef | null }> {
  const succeeded = await chargeOrRelease(deps.db, deps.ports.payments, {
    bookingId: input.bookingId,
    amountCents: claim.amountCents,
    idempotencyKey: input.idempotencyKey,
  });
  const result = await deps.db.transaction(async (tx) => {
    // Locked and read again: the booking may have changed while the provider was working.
    const { booking } = await lockOwnBooking(tx, input.bookingId, input.userId);
    if (booking.status !== BOOKING_STATUS.HELD) {
      // A parallel request of this key applied the result first: its answer stands.
      if (await paymentApplied(tx, booking.id)) return { state: booking, seat: null };
      deps.logger.warn(
        `payment of booking ${booking.id} finished while the booking was ${booking.status}; not applied`
      );
      // The money was taken, the booking is gone: refunded below, outside this transaction.
      if (succeeded) return { late: booking.status };
      throw new ConflictException(`Booking is ${booking.status}, the payment was not applied`);
    }
    // Planned at the claim time (stored, so also for a late retry): the hold was valid then.
    const plan = (from: BookingState, reason: TransitionReason) =>
      planTransition(from, reason, input.userId, claim.claimedAt);
    if (!succeeded) {
      const failed = plan(booking, TRANSITION_REASON.PAYMENT_FAILED);
      return { state: await storeOwnTransition(tx, input.userId, failed), seat: claim.seat };
    }
    const paid = await storeOwnTransition(
      tx,
      input.userId,
      plan(booking, TRANSITION_REASON.PAYMENT_SUCCEEDED)
    );
    const confirmed = await storeOwnTransition(
      tx,
      input.userId,
      plan(paid, TRANSITION_REASON.CONFIRMED)
    );
    // In this transaction: the rows exist if and only if the booking is CONFIRMED.
    await deps.ports.audit.record(tx, {
      actorId: input.userId,
      action: AUDIT_ACTION.BOOKING_PAID,
      subjectType: AUDIT_SUBJECT.BOOKING,
      subjectId: booking.id,
      requestId: input.requestId,
    });
    await deps.ports.outbox.enqueue(tx, {
      messageId: randomUUID(),
      type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
      bookingId: booking.id,
      eventId: claim.seat.eventId,
      userId: input.userId,
      occurredAt: claim.claimedAt.toISOString(),
    });
    return { state: confirmed, seat: claim.seat };
  });
  if ('late' in result) {
    return refundLateCharge(deps.db, deps.ports, { ...input, ...claim }, result.late);
  }
  return result;
}
