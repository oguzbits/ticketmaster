import { HOLD_OUTCOME } from '../../../core/hold-outcome.js';

export { HOLD_OUTCOME };

export interface HoldInput {
  eventId: string;
  seatId: string;
  userId: string;
}

export type HoldResult =
  | { outcome: typeof HOLD_OUTCOME.PLACED; bookingId: string; holdExpiresAt: Date }
  | { outcome: typeof HOLD_OUTCOME.SEAT_TAKEN | typeof HOLD_OUTCOME.CONSTRAINT_VIOLATION };

/** One way of keeping a seat from being held twice. The strategy of the event picks the adapter. */
export interface SeatReservation {
  hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult>;
}
