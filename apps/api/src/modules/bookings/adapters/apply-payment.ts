import { randomUUID } from 'node:crypto';

import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  OUTBOX_MESSAGE_TYPE,
  PAYMENT_ATTEMPT_STATUS,
  TRANSITION_REASON,
} from '@app/shared';

import type { Tx } from '../../../infrastructure/database/database.module.js';
import type { BookingState } from '../domain/booking-state-machine.js';
import type { BookingPorts } from './booking-ports.js';
import { planTransition, storeOwnTransition } from './booking-transitions.js';
import { setPaymentAttemptStatus } from './payment-attempts.js';

export interface ConfirmPaidInput {
  booking: BookingState;
  userId: string;
  idempotencyKey: string;
  requestId: string;
  eventId: string;
  at: Date;
}

/**
 * Transitions a `HELD` booking through `PAID -> CONFIRMED`, writes the `BOOKING_PAID` audit row,
 * enqueues `BOOKING_CONFIRMED`, and marks the payment attempt `APPLIED` inside one transaction.
 */
export async function confirmPaidBooking(
  tx: Tx,
  ports: Pick<BookingPorts, 'audit' | 'outbox'>,
  input: ConfirmPaidInput
): Promise<BookingState> {
  const paid = await storeOwnTransition(
    tx,
    input.userId,
    planTransition(input.booking, TRANSITION_REASON.PAYMENT_SUCCEEDED, input.userId, input.at)
  );
  const confirmed = await storeOwnTransition(
    tx,
    input.userId,
    planTransition(paid, TRANSITION_REASON.CONFIRMED, input.userId, input.at)
  );
  await ports.audit.record(tx, {
    actorId: input.userId,
    action: AUDIT_ACTION.BOOKING_PAID,
    subjectType: AUDIT_SUBJECT.BOOKING,
    subjectId: input.booking.id,
    requestId: input.requestId,
  });
  await ports.outbox.enqueue(tx, {
    messageId: randomUUID(),
    type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
    bookingId: input.booking.id,
    eventId: input.eventId,
    userId: input.userId,
    occurredAt: input.at.toISOString(),
  });
  await setPaymentAttemptStatus(tx, input.idempotencyKey, {
    from: [PAYMENT_ATTEMPT_STATUS.CLAIMED, PAYMENT_ATTEMPT_STATUS.CHARGED],
    to: PAYMENT_ATTEMPT_STATUS.APPLIED,
    at: input.at,
  });
  return confirmed;
}
