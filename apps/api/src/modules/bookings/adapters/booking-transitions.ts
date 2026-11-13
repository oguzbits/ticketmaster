import type { TransitionReason } from '@app/shared';
import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { bookings, bookingTransitions } from '../../../infrastructure/database/schema.js';
import {
  type BookingState,
  BookingTransitionError,
  transition,
  type TransitionResult,
} from '../domain/booking-state-machine.js';
import type { Tx } from './insert-hold.js';

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

/** Writes the new status and the transition record; every transition is stored. */
export async function storeTransition(
  tx: Tx,
  { booking, record }: TransitionResult,
  paymentIdempotencyKey?: string
): Promise<BookingState> {
  await tx
    .update(bookings)
    .set({
      status: booking.status,
      updatedAt: record.at,
      ...(paymentIdempotencyKey === undefined ? {} : { paymentIdempotencyKey }),
    })
    .where(eq(bookings.id, booking.id));
  await tx.insert(bookingTransitions).values(record);
  return booking;
}
