import type { OutboxService } from '../../outbox/index.js';
import type { WaitingRoomService } from '../../waiting-room/index.js';
import type { PaymentProvider } from '../domain/payment-provider.js';
import type { SeatChangePublisher } from '../domain/seat-change.js';

/**
 * What the booking service calls besides its own tables: the charge, the notice to viewers and the
 * outbox that announces a confirmed booking (written in the booking's transaction), and the
 * admission check of a waiting room.
 */
export interface BookingPorts {
  payments: PaymentProvider;
  seatChanges: SeatChangePublisher;
  outbox: OutboxService;
  waitingRoom: WaitingRoomService;
}

export const BOOKING_PORTS = Symbol('BOOKING_PORTS');
