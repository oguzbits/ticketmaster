import type { BookingStatus, TransitionReason } from '@app/shared';
import { BOOKING_STATUS, TRANSITION_REASON } from '@app/shared';
import { describe, expect, it } from 'vitest';

import type { BookingState } from './booking-state-machine.js';
import { BookingTransitionError, startHold, transition } from './booking-state-machine.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const TTL_SECONDS = 600;
const BOOKING_ID = 'booking-1';
const ACTOR_ID = 'user-1';
const HOLD_EXPIRES_AT = new Date(NOW.getTime() + TTL_SECONDS * 1000);
/** One second before the hold expires. */
const WITHIN_HOLD = new Date(HOLD_EXPIRES_AT.getTime() - 1000);

const bookingIn = (status: BookingStatus): BookingState => ({
  id: BOOKING_ID,
  status,
  holdExpiresAt: HOLD_EXPIRES_AT,
});

type Allowed = readonly [BookingStatus, TransitionReason, BookingStatus, Date];

const ALLOWED: readonly Allowed[] = [
  [BOOKING_STATUS.HELD, TRANSITION_REASON.PAYMENT_SUCCEEDED, BOOKING_STATUS.PAID, WITHIN_HOLD],
  [BOOKING_STATUS.PAID, TRANSITION_REASON.CONFIRMED, BOOKING_STATUS.CONFIRMED, HOLD_EXPIRES_AT],
  [BOOKING_STATUS.HELD, TRANSITION_REASON.PAYMENT_FAILED, BOOKING_STATUS.CANCELLED, WITHIN_HOLD],
  [BOOKING_STATUS.HELD, TRANSITION_REASON.HOLD_EXPIRED, BOOKING_STATUS.EXPIRED, HOLD_EXPIRES_AT],
  [BOOKING_STATUS.HELD, TRANSITION_REASON.CANCELLED_BY_USER, BOOKING_STATUS.CANCELLED, WITHIN_HOLD],
  [BOOKING_STATUS.CONFIRMED, TRANSITION_REASON.CANCELLED_BY_USER, BOOKING_STATUS.CANCELLED, NOW],
];

const isAllowed = (from: BookingStatus, reason: TransitionReason): boolean =>
  ALLOWED.some(([f, r]) => f === from && r === reason);

const FORBIDDEN = Object.values(BOOKING_STATUS).flatMap((from) =>
  Object.values(TRANSITION_REASON)
    .filter((reason) => !isAllowed(from, reason))
    .map((reason) => [from, reason] as const)
);

describe('startHold', () => {
  it('creates a HELD booking that expires after the ttl and records the hold', () => {
    const result = startHold({
      bookingId: BOOKING_ID,
      actorId: ACTOR_ID,
      now: NOW,
      ttlSeconds: TTL_SECONDS,
    });
    expect(result.booking).toEqual({
      id: BOOKING_ID,
      status: BOOKING_STATUS.HELD,
      holdExpiresAt: HOLD_EXPIRES_AT,
    });
    expect(result.record).toEqual({
      bookingId: BOOKING_ID,
      fromStatus: null,
      toStatus: BOOKING_STATUS.HELD,
      reason: TRANSITION_REASON.HOLD,
      actorId: ACTOR_ID,
      at: NOW,
    });
  });
});

describe('transition', () => {
  it.each(ALLOWED)('%s + %s -> %s', (from, reason, to, at) => {
    const result = transition(bookingIn(from), reason, ACTOR_ID, at);
    expect(result.booking).toEqual({ ...bookingIn(from), status: to });
    expect(result.record).toEqual({
      bookingId: BOOKING_ID,
      fromStatus: from,
      toStatus: to,
      reason,
      actorId: ACTOR_ID,
      at,
    });
  });

  it.each(FORBIDDEN)('%s + %s is refused', (from, reason) => {
    // Time-dependent reasons are tried on both sides of the expiry so only the table can refuse.
    for (const at of [WITHIN_HOLD, HOLD_EXPIRES_AT]) {
      expect(() => transition(bookingIn(from), reason, ACTOR_ID, at)).toThrow(
        BookingTransitionError
      );
    }
  });

  it('refuses PAYMENT_SUCCEEDED at holdExpiresAt', () => {
    expect(() =>
      transition(
        bookingIn(BOOKING_STATUS.HELD),
        TRANSITION_REASON.PAYMENT_SUCCEEDED,
        ACTOR_ID,
        HOLD_EXPIRES_AT
      )
    ).toThrow(BookingTransitionError);
  });

  it.each([TRANSITION_REASON.PAYMENT_FAILED, TRANSITION_REASON.CANCELLED_BY_USER])(
    'still allows %s on a HELD booking past holdExpiresAt (the expiry job may not have run)',
    (reason) => {
      const result = transition(bookingIn(BOOKING_STATUS.HELD), reason, ACTOR_ID, HOLD_EXPIRES_AT);
      expect(result.booking.status).toBe(BOOKING_STATUS.CANCELLED);
    }
  );

  it('refuses HOLD_EXPIRED one millisecond before holdExpiresAt', () => {
    expect(() =>
      transition(
        bookingIn(BOOKING_STATUS.HELD),
        TRANSITION_REASON.HOLD_EXPIRED,
        ACTOR_ID,
        new Date(HOLD_EXPIRES_AT.getTime() - 1)
      )
    ).toThrow(BookingTransitionError);
  });

  it('carries the current status and the reason in the error', () => {
    const error = (() => {
      try {
        transition(bookingIn(BOOKING_STATUS.EXPIRED), TRANSITION_REASON.CONFIRMED, ACTOR_ID, NOW);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(BookingTransitionError);
    expect(error).toMatchObject({
      from: BOOKING_STATUS.EXPIRED,
      reason: TRANSITION_REASON.CONFIRMED,
    });
  });
});
