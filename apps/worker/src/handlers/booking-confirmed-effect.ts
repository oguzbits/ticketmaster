import type { Tx } from '@app/api/database';
import type { OUTBOX_MESSAGE_TYPE, QueueMessage } from '@app/shared';

export type BookingConfirmedMessage = Extract<
  QueueMessage,
  { type: typeof OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED }
>;

/** Names under which an effect is recorded in `processed_messages`: one per effect of a message. */
export const CONSUMER_NAME = {
  TICKET_PDF: 'ticket-pdf',
  CONFIRMATION_MAIL: 'confirmation-mail',
} as const;

/**
 * One effect of a confirmed booking. The consumer runs the effects of a message in order, each
 * under its own dedupe record (`consumer`) and inside that record's transaction (`tx`).
 */
export interface BookingConfirmedEffect {
  readonly consumer: string;
  handle(message: BookingConfirmedMessage, tx: Tx): Promise<void>;
}
