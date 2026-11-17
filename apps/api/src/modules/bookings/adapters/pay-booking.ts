import { BOOKING_STATUS, PAYMENT_ATTEMPT_STATUS, TRANSITION_REASON } from '@app/shared';
import { ConflictException, type Logger } from '@nestjs/common';

import type { Clock } from '../../../core/clock.js';
import type { Database } from '../../../infrastructure/database/database.module.js';
import type { BookingState } from '../domain/booking-state-machine.js';
import { confirmPaidBooking } from './apply-payment.js';
import type { BookingPorts } from './booking-ports.js';
import {
  claimPaymentKey,
  paymentApplied,
  planTransition,
  storeOwnTransition,
} from './booking-transitions.js';
import { chargeOrRelease } from './charge-or-release.js';
import { lockOwnBooking } from './lock-own-booking.js';
import { recordPaymentAttemptClaim, setPaymentAttemptStatus } from './payment-attempts.js';
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
 * 1. claim: lock the booking, refuse what cannot be paid, store the key and attempt (commit);
 * 2. charge: call the provider with the key, outside any transaction, and record CHARGED;
 * 3. apply: lock the booking again, re-read its status and store the result.
 */
export async function payBooking(
  deps: PayBookingDeps,
  input: PayInput
): Promise<{ state: BookingState; seat: SeatRef | null }> {
  const claim = await claimPayment(deps.db, deps.clock, input);
  if (claim.settled !== null) return { state: claim.settled, seat: null };
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
      if (await paymentApplied(tx, booking.id)) return { settled: booking };
      throw new ConflictException(`Booking is ${booking.status}, the payment was not applied`);
    }
    const claimedAt = sameKey && paymentClaimedAt !== null ? paymentClaimedAt : clock.now();
    planTransition(booking, TRANSITION_REASON.PAYMENT_SUCCEEDED, input.userId, claimedAt);
    if (!sameKey) {
      if (paymentIdempotencyKey !== null) {
        throw new ConflictException('Another payment of this booking is in progress');
      }
      await claimPaymentKey(tx, booking.id, input.idempotencyKey, claimedAt);
      await recordPaymentAttemptClaim(tx, {
        idempotencyKey: input.idempotencyKey,
        bookingId: booking.id,
        userId: input.userId,
        amountCents: priceCents,
        requestId: input.requestId,
        claimedAt,
      });
    }
    return { settled: null, amountCents: priceCents, seat, claimedAt };
  });
}

/** Steps 2 and 3. */
async function chargeAndApply(
  deps: Omit<PayBookingDeps, 'flights'>,
  input: PayInput,
  claim: { amountCents: number; seat: SeatRef; claimedAt: Date }
): Promise<{ state: BookingState; seat: SeatRef | null }> {
  const succeeded = await chargeOrRelease(
    deps.db,
    deps.ports.payments,
    {
      bookingId: input.bookingId,
      amountCents: claim.amountCents,
      idempotencyKey: input.idempotencyKey,
    },
    deps.clock.now()
  );
  if (succeeded) {
    await setPaymentAttemptStatus(deps.db, input.idempotencyKey, {
      from: [PAYMENT_ATTEMPT_STATUS.CLAIMED],
      to: PAYMENT_ATTEMPT_STATUS.CHARGED,
      at: deps.clock.now(),
    });
  }
  const result = await applyChargedOutcome(deps, input, claim, succeeded);
  if ('late' in result) {
    return refundLateCharge(
      deps.db,
      deps.ports,
      { ...input, amountCents: claim.amountCents, at: deps.clock.now() },
      result.late
    );
  }
  return result;
}

async function applyChargedOutcome(
  deps: Omit<PayBookingDeps, 'flights'>,
  input: PayInput,
  claim: { amountCents: number; seat: SeatRef; claimedAt: Date },
  succeeded: boolean
): Promise<{ state: BookingState; seat: SeatRef | null } | { late: BookingState['status'] }> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const { booking } = await lockOwnBooking(tx, input.bookingId, input.userId);
    if (booking.status !== BOOKING_STATUS.HELD) {
      return applyNonHeldOutcome(tx, deps.logger, {
        booking,
        idempotencyKey: input.idempotencyKey,
        succeeded,
        now,
      });
    }
    if (!succeeded) {
      const failed = planTransition(
        booking,
        TRANSITION_REASON.PAYMENT_FAILED,
        input.userId,
        claim.claimedAt
      );
      await setPaymentAttemptStatus(tx, input.idempotencyKey, {
        from: [PAYMENT_ATTEMPT_STATUS.CLAIMED],
        to: PAYMENT_ATTEMPT_STATUS.APPLIED,
        at: now,
      });
      return { state: await storeOwnTransition(tx, input.userId, failed), seat: claim.seat };
    }
    const state = await confirmPaidBooking(tx, deps.ports, {
      booking,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      eventId: claim.seat.eventId,
      at: claim.claimedAt,
    });
    return { state, seat: claim.seat };
  });
}

async function applyNonHeldOutcome(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  logger: Logger,
  input: { booking: BookingState; idempotencyKey: string; succeeded: boolean; now: Date }
): Promise<{ state: BookingState; seat: null } | { late: BookingState['status'] }> {
  const { booking, idempotencyKey, succeeded, now } = input;
  if (await paymentApplied(tx, booking.id)) {
    await setPaymentAttemptStatus(tx, idempotencyKey, {
      from: [PAYMENT_ATTEMPT_STATUS.CLAIMED, PAYMENT_ATTEMPT_STATUS.CHARGED],
      to: PAYMENT_ATTEMPT_STATUS.APPLIED,
      at: now,
    });
    return { state: booking, seat: null };
  }
  logger.warn(
    `payment of booking ${booking.id} finished while the booking was ${booking.status}; not applied`
  );
  if (succeeded) {
    await setPaymentAttemptStatus(tx, idempotencyKey, {
      from: [PAYMENT_ATTEMPT_STATUS.CLAIMED, PAYMENT_ATTEMPT_STATUS.CHARGED],
      to: PAYMENT_ATTEMPT_STATUS.REFUND_PENDING,
      at: now,
    });
    return { late: booking.status };
  }
  await setPaymentAttemptStatus(tx, idempotencyKey, {
    from: [PAYMENT_ATTEMPT_STATUS.CLAIMED],
    to: PAYMENT_ATTEMPT_STATUS.APPLIED,
    at: now,
  });
  throw new ConflictException(`Booking is ${booking.status}, the payment was not applied`);
}
