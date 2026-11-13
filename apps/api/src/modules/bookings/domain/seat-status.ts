import type { BookingStatus, SeatStatus } from '@app/shared';
import { BOOKING_STATUS, SEAT_STATUS } from '@app/shared';

/** Bookings in these statuses occupy their seat. */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = [
  BOOKING_STATUS.HELD,
  BOOKING_STATUS.PAID,
  BOOKING_STATUS.CONFIRMED,
];

const SEAT_STATUS_BY_BOOKING: Record<BookingStatus, SeatStatus> = {
  [BOOKING_STATUS.HELD]: SEAT_STATUS.HELD,
  [BOOKING_STATUS.PAID]: SEAT_STATUS.SOLD,
  [BOOKING_STATUS.CONFIRMED]: SEAT_STATUS.SOLD,
  [BOOKING_STATUS.EXPIRED]: SEAT_STATUS.AVAILABLE,
  [BOOKING_STATUS.CANCELLED]: SEAT_STATUS.AVAILABLE,
};

export function seatStatusOf(activeBookingStatus: BookingStatus | null): SeatStatus {
  return activeBookingStatus === null
    ? SEAT_STATUS.AVAILABLE
    : SEAT_STATUS_BY_BOOKING[activeBookingStatus];
}
