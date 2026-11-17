import { array, boolean, type infer as ZodInfer, iso, object, string, union, url, uuid } from 'zod';

import { BookingStatusSchema, SeatStatusSchema, TransitionReasonSchema } from './booking.js';
import { SeatSchema } from './events.js';

export const HoldRequestSchema = object({
  eventId: uuid(),
  seatId: uuid(),
  admissionToken: string().min(1).optional(),
});

export const BookingTransitionSchema = object({
  fromStatus: BookingStatusSchema.nullable(),
  toStatus: BookingStatusSchema,
  reason: TransitionReasonSchema,
  at: iso.datetime(),
});

export const BookingSchema = object({
  id: uuid(),
  eventId: uuid(),
  seatId: uuid(),
  status: BookingStatusSchema,
  holdExpiresAt: iso.datetime(),
  // The ticket PDF is stored and can be downloaded.
  ticketReady: boolean(),
  seat: SeatSchema.pick({ section: true, row: true, number: true }),
  transitions: array(BookingTransitionSchema),
});

/**
 * Header of the payment request; the same key again returns the first answer without a second
 * charge. Keys are unique over all users, so a UUID is required: a guessable key of one user would
 * block another user and reveal that the key exists.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IdempotencyKeySchema = uuid();

export const BookingListResponseSchema = array(BookingSchema);

/** One seat changed its derived status; published after the booking transaction commits. */
export const SeatChangeSchema = object({
  eventId: uuid(),
  seatId: uuid(),
  status: SeatStatusSchema,
  at: iso.datetime(),
});

/** First event of the seat stream: every seat of the event with its status right now. */
export const SeatSnapshotSchema = object({ seats: array(SeatSchema) });

export const SEAT_STREAM_EVENT = {
  SNAPSHOT: 'snapshot',
  CHANGE: 'change',
} as const;

export const TicketDownloadSchema = object({
  url: union([url(), string().startsWith('/')]),
  expiresAt: iso.datetime(),
});

export type HoldRequest = ZodInfer<typeof HoldRequestSchema>;
export type BookingTransition = ZodInfer<typeof BookingTransitionSchema>;
export type Booking = ZodInfer<typeof BookingSchema>;
export type SeatChange = ZodInfer<typeof SeatChangeSchema>;
export type SeatSnapshot = ZodInfer<typeof SeatSnapshotSchema>;
export type TicketDownload = ZodInfer<typeof TicketDownloadSchema>;
