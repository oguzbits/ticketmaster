import type { TransitionReason } from '@app/shared';
import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Tx } from '../../../infrastructure/database/database.module.js';
import { bookings, bookingTransitions } from '../../../infrastructure/database/schema.js';
import {
  type BookingState,
  BookingTransitionError,
  transition,
  type TransitionResult,
} from '../domain/booking-state-machine.js';

const PAYMENT_KEY_CONSTRAINT = 'bookings_payment_idempotency_key_unique';
// Drizzle wraps the postgres.js server error; the fields sit on `cause`.
const PaymentKeyViolationSchema = z.object({
  code: z.literal('23505'),
  constraint_name: z.literal(PAYMENT_KEY_CONSTRAINT),
});

/** Runs the state machine; a refused transition is a conflict with the booking's current state. */
export function planTransition(
  booking: BookingState,
  reason: TransitionReason,
  actorId: string,
  now: Date
): TransitionResult {
  try {
    return transition(booking, reason, actorId, now);
  } catch (error) {
    if (error instanceof BookingTransitionError) throw new ConflictException(error.message);
    throw error;
  }
}

/**
 * Stores the payment idempotency key before the charge. The column is unique over all bookings: a
 * key another booking already holds is a conflict, so nothing is charged for it.
 */
export async function claimPaymentKey(tx: Tx, bookingId: string, key: string): Promise<void> {
  try {
    await tx.update(bookings).set({ paymentIdempotencyKey: key }).where(eq(bookings.id, bookingId));
  } catch (error) {
    if (PaymentKeyViolationSchema.safeParse(error instanceof Error ? error.cause : null).success) {
      throw new ConflictException('Idempotency key already used for another booking');
    }
    throw error;
  }
}

/** Writes the new status and the transition record; every transition is stored. */
export async function storeTransition(
  tx: Tx,
  { booking, record }: TransitionResult
): Promise<BookingState> {
  await tx
    .update(bookings)
    .set({ status: booking.status, updatedAt: record.at })
    .where(eq(bookings.id, booking.id));
  await tx.insert(bookingTransitions).values(record);
  return booking;
}
