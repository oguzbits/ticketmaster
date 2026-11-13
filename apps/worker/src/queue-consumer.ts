import { setTimeout as sleep } from 'node:timers/promises';

import { MESSAGE_QUEUE, type MessageQueue, OutboxService } from '@app/api/outbox';
import { OUTBOX_MESSAGE_TYPE, type QueueMessage, QueueMessageSchema } from '@app/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { BookingConfirmedHandler } from './handlers/booking-confirmed.handler.js';

/** The pause after a failing iteration, so a queue or database that is down is not hammered. */
const ERROR_PAUSE_MS = 1000;

/** A body that is no known queue message. Carries no text of the body: it may hold data. */
class UnparsableMessageError extends Error {
  override name = 'UnparsableMessageError';
}

/**
 * Receives one message at a time from the queue (long poll) and hands it to the handler of its
 * type, once per message ID. The message is deleted only after the handler succeeded (or the
 * message was handled before); every failure leaves it in the queue, which delivers it again after
 * the visibility timeout and moves it to the dead-letter queue after the receive limit.
 */
@Injectable()
export class QueueConsumer implements OnModuleInit, OnModuleDestroy {
  // Public so a spec can use a shorter pause.
  errorPauseMs = ERROR_PAUSE_MS;
  private readonly logger = new Logger(QueueConsumer.name);
  private readonly stopping = new AbortController();
  private loop: Promise<void> = Promise.resolve();

  constructor(
    @Inject(MESSAGE_QUEUE) private readonly queue: MessageQueue,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(BookingConfirmedHandler) private readonly bookingConfirmed: BookingConfirmedHandler
  ) {}

  onModuleInit(): void {
    this.loop = this.consume();
  }

  /** Ends the loop and the open long poll; a message that is being handled finishes first. */
  async onModuleDestroy(): Promise<void> {
    this.stopping.abort();
    await this.loop;
  }

  private async consume(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      try {
        await this.next();
      } catch (error) {
        if (this.stopping.signal.aborted) return;
        this.logger.error(
          `queue consumer failed, retrying: ${error instanceof Error ? error.name : 'unknown'}`
        );
        await this.pause();
      }
    }
  }

  private async pause(): Promise<void> {
    try {
      await sleep(this.errorPauseMs, undefined, { signal: this.stopping.signal });
    } catch (error) {
      // Only a shutdown interrupts the pause.
      if (!this.stopping.signal.aborted) throw error;
    }
  }

  private async next(): Promise<void> {
    const [received] = await this.queue.receive(1, this.stopping.signal);
    if (received === undefined) return;
    const message = this.parse(received.body);
    if (message === null) {
      // The ID only, never the body. Not deleted: it reaches the dead-letter queue.
      this.logger.warn(`message ${received.messageId} is not a known queue message`);
      throw new UnparsableMessageError();
    }
    await this.dispatch(message);
    await this.queue.delete(received.receiptHandle);
  }

  private parse(body: string): QueueMessage | null {
    try {
      const result = QueueMessageSchema.safeParse(JSON.parse(body));
      return result.success ? result.data : null;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  /** Runs the handler of the message's type under the dedupe record of that handler. */
  private async dispatch(message: QueueMessage): Promise<void> {
    switch (message.type) {
      case OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED:
        await this.outbox.processOnce(this.bookingConfirmed.consumer, message.messageId, () =>
          this.bookingConfirmed.handle(message)
        );
        return;
    }
  }
}
