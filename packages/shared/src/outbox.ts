import { discriminatedUnion, type infer as ZodInfer, iso, literal, object, uuid } from 'zod';

/** Types of the messages that go through the outbox and the queue. */
export const OUTBOX_MESSAGE_TYPE = {
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
} as const;

/**
 * A booking reached CONFIRMED. `messageId` is the ID of the outbox row and the idempotency key of
 * every consumer (`processed_messages`): delivery is at least once, so the same message can arrive
 * more than once and must take effect once. IDs only; no name, email or other personal data.
 */
const BookingConfirmedMessageSchema = object({
  messageId: uuid(),
  type: literal(OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED),
  bookingId: uuid(),
  eventId: uuid(),
  userId: uuid(),
  occurredAt: iso.datetime(),
});

/** Every message the queue carries, told apart by `type`. */
export const QueueMessageSchema = discriminatedUnion('type', [BookingConfirmedMessageSchema]);

export type QueueMessage = ZodInfer<typeof QueueMessageSchema>;
