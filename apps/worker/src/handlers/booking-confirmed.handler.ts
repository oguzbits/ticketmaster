import { OUTBOX_MESSAGE_TYPE, type QueueMessage } from '@app/shared';
import { Injectable, Logger } from '@nestjs/common';

export type BookingConfirmedMessage = Extract<
  QueueMessage,
  { type: typeof OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED }
>;

/** Names under which a handler is recorded in `processed_messages`: one per effect of a message. */
export const CONSUMER_NAME = {
  BOOKING_CONFIRMED_LOG: 'booking-confirmed-log',
} as const;

/** Slice A only proves the chain (dedupe, delete after success, dead-letter queue): it logs the ID. */
@Injectable()
export class BookingConfirmedHandler {
  readonly consumer = CONSUMER_NAME.BOOKING_CONFIRMED_LOG;
  private readonly logger = new Logger(BookingConfirmedHandler.name);

  async handle(message: BookingConfirmedMessage): Promise<void> {
    this.logger.log(`booking ${message.bookingId} confirmed`);
  }
}
