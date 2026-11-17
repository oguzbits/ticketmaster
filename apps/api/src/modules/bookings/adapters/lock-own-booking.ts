import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { Tx } from '../../../infrastructure/database/database.module.js';
import { bookings, bookingSeats, seats } from '../../../infrastructure/database/schema.js';
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
  seats: { eventId: string; seatId: string }[];
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
    })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .for('update', { of: bookings });
  if (row === undefined) throw new NotFoundException('Booking not found');
  if (row.ownerId !== userId) throw new ForbiddenException('Booking belongs to another user');
  const seatRows = await tx
    .select({
      seatId: bookingSeats.seatId,
      priceCents: seats.priceCents,
    })
    .from(bookingSeats)
    .innerJoin(seats, eq(seats.id, bookingSeats.seatId))
    .where(eq(bookingSeats.bookingId, bookingId));
  const { id, status, holdExpiresAt, eventId } = row;
  return {
    booking: { id, status, holdExpiresAt },
    paymentIdempotencyKey: row.paymentIdempotencyKey,
    paymentClaimedAt: row.paymentClaimedAt,
    priceCents: seatRows.reduce((sum, s) => sum + s.priceCents, 0),
    seats: seatRows.map(({ seatId }) => ({ eventId, seatId })),
  };
}
