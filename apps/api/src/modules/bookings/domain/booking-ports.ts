import type { PaymentProvider } from './payment-provider.js';
import type { SeatChangePublisher } from './seat-change.js';

/** What the booking service calls outside the database: the charge and the notice to viewers. */
export interface BookingPorts {
  payments: PaymentProvider;
  seatChanges: SeatChangePublisher;
}

export const BOOKING_PORTS = Symbol('BOOKING_PORTS');
