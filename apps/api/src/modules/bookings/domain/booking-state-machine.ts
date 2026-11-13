import type { BookingStatus, TransitionReason } from '@app/shared';
import { BOOKING_STATUS, TRANSITION_REASON } from '@app/shared';

export interface BookingState {
  id: string;
  status: BookingStatus;
  holdExpiresAt: Date;
}

export interface TransitionRecord {
  bookingId: string;
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  reason: TransitionReason;
  actorId: string;
  at: Date;
}

export interface TransitionResult {
  booking: BookingState;
  record: TransitionRecord;
}

export class BookingTransitionError extends Error {
  constructor(
    readonly from: BookingStatus,
    readonly reason: TransitionReason
  ) {
    super(`Booking in status ${from} cannot take transition ${reason}`);
    this.name = 'BookingTransitionError';
  }
}

/** HOLD is not a transition: it creates the booking (`startHold`). */
type TransitionRule = { from: readonly BookingStatus[]; to: BookingStatus };

const TRANSITIONS: Record<
  Exclude<TransitionReason, typeof TRANSITION_REASON.HOLD>,
  TransitionRule
> = {
  [TRANSITION_REASON.PAYMENT_SUCCEEDED]: {
    from: [BOOKING_STATUS.HELD],
    to: BOOKING_STATUS.PAID,
  },
  [TRANSITION_REASON.CONFIRMED]: {
    from: [BOOKING_STATUS.PAID],
    to: BOOKING_STATUS.CONFIRMED,
  },
  [TRANSITION_REASON.PAYMENT_FAILED]: {
    from: [BOOKING_STATUS.HELD],
    to: BOOKING_STATUS.CANCELLED,
  },
  [TRANSITION_REASON.HOLD_EXPIRED]: {
    from: [BOOKING_STATUS.HELD],
    to: BOOKING_STATUS.EXPIRED,
  },
  [TRANSITION_REASON.CANCELLED_BY_USER]: {
    from: [BOOKING_STATUS.HELD, BOOKING_STATUS.CONFIRMED],
    to: BOOKING_STATUS.CANCELLED,
  },
};

export function startHold(input: {
  bookingId: string;
  actorId: string;
  now: Date;
  ttlSeconds: number;
}): TransitionResult {
  const { bookingId, actorId, now, ttlSeconds } = input;
  return {
    booking: {
      id: bookingId,
      status: BOOKING_STATUS.HELD,
      holdExpiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    },
    record: {
      bookingId,
      fromStatus: null,
      toStatus: BOOKING_STATUS.HELD,
      reason: TRANSITION_REASON.HOLD,
      actorId,
      at: now,
    },
  };
}

export function transition(
  booking: BookingState,
  reason: TransitionReason,
  actorId: string,
  now: Date
): TransitionResult {
  if (reason === TRANSITION_REASON.HOLD) {
    throw new BookingTransitionError(booking.status, reason);
  }
  const rule = TRANSITIONS[reason];
  if (!rule.from.includes(booking.status)) {
    throw new BookingTransitionError(booking.status, reason);
  }
  const expired = now.getTime() >= booking.holdExpiresAt.getTime();
  // A hold that ran out cannot be paid, even before the expiry job has run.
  if (reason === TRANSITION_REASON.PAYMENT_SUCCEEDED && expired) {
    throw new BookingTransitionError(booking.status, reason);
  }
  if (reason === TRANSITION_REASON.HOLD_EXPIRED && !expired) {
    throw new BookingTransitionError(booking.status, reason);
  }
  return {
    booking: { ...booking, status: rule.to },
    record: {
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: rule.to,
      reason,
      actorId,
      at: now,
    },
  };
}
