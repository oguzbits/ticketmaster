import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { Tx } from '../../../infrastructure/database/database.module.js';
import { bookings, seats } from '../../../infrastructure/database/schema.js';
import type { BookingState } from '../domain/booking-state-machine.js';

/** Locks the booking row for the transaction; unknown is NotFound, someone else's is Forbidden. */
export async function lockOwnBooking(
  tx: Tx,
  bookingId: string,
  userId: string
): Promise<{
  booking: BookingState;
  paymentIdempotencyKey: string | null;
  paymentClaimedAt: Date | null;
  priceCents: number;
  seat: { eventId: string; seatId: string };
}> {
  const [row] = await tx
    .select({
      id: bookings.id,
      status: bookings.status,
      holdExpiresAt: bookings.holdExpiresAt,
      paymentIdempotencyKey: bookings.paymentIdempotencyKey,
      paymentClaimedAt: bookings.paymentClaimedAt,
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
  const { id, status, holdExpiresAt, priceCents, eventId, seatId } = row;
  return {
    booking: { id, status, holdExpiresAt },
    paymentIdempotencyKey: row.paymentIdempotencyKey,
    paymentClaimedAt: row.paymentClaimedAt,
    priceCents,
    seat: { eventId, seatId },
  };
}
