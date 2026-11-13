import { z } from 'zod';

import { BookingStatusSchema, SeatStatusSchema, TransitionReasonSchema } from './booking.js';
import { SeatSchema } from './events.js';

export const HoldRequestSchema = z.object({ eventId: z.uuid(), seatId: z.uuid() });

export const BookingTransitionSchema = z.object({
  fromStatus: BookingStatusSchema.nullable(),
  toStatus: BookingStatusSchema,
  reason: TransitionReasonSchema,
  at: z.iso.datetime(),
});

export const BookingSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  seatId: z.uuid(),
  status: BookingStatusSchema,
  holdExpiresAt: z.iso.datetime(),
  seat: SeatSchema.pick({ section: true, row: true, number: true }),
  transitions: z.array(BookingTransitionSchema),
});

/**
 * Header of the payment request; the same key again returns the first answer without a second
 * charge. Keys are unique over all users, so a UUID is required: a guessable key of one user would
 * block another user and reveal that the key exists.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IdempotencyKeySchema = z.uuid();

export const BookingListResponseSchema = z.array(BookingSchema);

/** One seat changed its derived status; published after the booking transaction commits. */
export const SeatChangeSchema = z.object({
  eventId: z.uuid(),
  seatId: z.uuid(),
  status: SeatStatusSchema,
  at: z.iso.datetime(),
});

/** First event of the seat stream: every seat of the event with its status right now. */
export const SeatSnapshotSchema = z.object({ seats: z.array(SeatSchema) });

export const SEAT_STREAM_EVENT = {
  SNAPSHOT: 'snapshot',
  CHANGE: 'change',
} as const;

export type HoldRequest = z.infer<typeof HoldRequestSchema>;
export type BookingTransition = z.infer<typeof BookingTransitionSchema>;
export type Booking = z.infer<typeof BookingSchema>;
export type SeatChange = z.infer<typeof SeatChangeSchema>;
export type SeatSnapshot = z.infer<typeof SeatSnapshotSchema>;
