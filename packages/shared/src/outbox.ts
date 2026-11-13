import { z } from 'zod';

/** Types of the messages that go through the outbox and the queue. */
export const OUTBOX_MESSAGE_TYPE = {
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
} as const;

/**
 * A booking reached CONFIRMED. `messageId` is the ID of the outbox row and the idempotency key of
 * every consumer (`processed_messages`): delivery is at least once, so the same message can arrive
 * more than once and must take effect once. IDs only; no name, email or other personal data.
 */
const BookingConfirmedMessageSchema = z.object({
  messageId: z.uuid(),
  type: z.literal(OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED),
  bookingId: z.uuid(),
  eventId: z.uuid(),
  userId: z.uuid(),
  occurredAt: z.iso.datetime(),
});

/** Every message the queue carries, told apart by `type`. */
export const QueueMessageSchema = z.discriminatedUnion('type', [BookingConfirmedMessageSchema]);

export type QueueMessage = z.infer<typeof QueueMessageSchema>;
