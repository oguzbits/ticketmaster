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

export const BookingListResponseSchema = z.array(BookingSchema);

/** One seat changed its derived status; published after the booking transaction commits. */
export const SeatChangeSchema = z.object({
  eventId: z.uuid(),
  seatId: z.uuid(),
  status: SeatStatusSchema,
  at: z.iso.datetime(),
});

export const SEAT_STREAM_EVENT = {
  SNAPSHOT: 'snapshot',
  CHANGE: 'change',
} as const;

export type HoldRequest = z.infer<typeof HoldRequestSchema>;
export type BookingTransition = z.infer<typeof BookingTransitionSchema>;
export type Booking = z.infer<typeof BookingSchema>;
export type SeatChange = z.infer<typeof SeatChangeSchema>;
