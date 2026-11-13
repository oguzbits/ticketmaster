export { publishSeatChange } from './adapters/publish-seat-change.js';
export { BookingsModule } from './bookings.module.js';
export { BookingsService } from './bookings.service.js';
export {
  SEAT_CHANGE_PUBLISHER,
  type SeatChangePublisher,
  seatChannel,
} from './domain/seat-change.js';
export {
  HOLD_OUTCOME,
  type HoldInput,
  type HoldResult,
  type SeatReservation,
} from './domain/seat-reservation.js';
export { ACTIVE_BOOKING_STATUSES, seatStatusOf } from './domain/seat-status.js';
// Test support: other modules' specs build a real service without reaching into this module.
export { createBookingsService } from './testing/create-bookings-service.js';
