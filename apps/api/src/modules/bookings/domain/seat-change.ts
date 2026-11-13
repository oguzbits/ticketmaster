import type { SeatChange } from '@app/shared';

/** Tells every viewer of an event that one seat changed. Called after the booking transaction commits. */
export interface SeatChangePublisher {
  publish(change: SeatChange): Promise<void>;
}

export const SEAT_CHANGE_PUBLISHER = Symbol('SEAT_CHANGE_PUBLISHER');

/** The channel of an event; the publisher and the stream subscriber both build it with this. */
export const seatChannel = (eventId: string): string => `seats:${eventId}`;
