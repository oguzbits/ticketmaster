import { setTimeout as sleep } from 'node:timers/promises';

import { BUSINESS_METRICS, type BusinessMetrics, EFFECT_OUTCOME } from '@app/api/metrics';
import { MESSAGE_QUEUE, type MessageQueue, OutboxService } from '@app/api/outbox';
import { SPAN_ATTR, SPAN_NAME, SpanKind, withExtractedContext, withSpan } from '@app/api/tracing';
import { OUTBOX_MESSAGE_TYPE, type QueueMessage, QueueMessageSchema } from '@app/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import type {
  BookingConfirmedEffect,
  BookingConfirmedMessage,
} from './handlers/booking-confirmed-effect.js';

/** The effects of a booking-confirmed message, in the order they run: the mail reads the PDF the first one stored. */
export const BOOKING_CONFIRMED_EFFECTS = Symbol('BOOKING_CONFIRMED_EFFECTS');

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
    @Inject(BUSINESS_METRICS) private readonly metrics: BusinessMetrics,
    @Inject(BOOKING_CONFIRMED_EFFECTS) private readonly effects: readonly BookingConfirmedEffect[]
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
    // The span ends on every path: withSpan ends it after the handlers, whether they return or throw.
    // Only the message ID is an attribute, never a body or a field of the message.
    await withExtractedContext(received.traceparent, () =>
      withSpan(SPAN_NAME.QUEUE_PROCESS, () => this.dispatch(message), {
        kind: SpanKind.CONSUMER,
        attributes: { [SPAN_ATTR.MESSAGE_ID]: received.messageId },
      })
    );
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

  /**
   * Runs the effects of the message's type in order, each under the dedupe record of its own name:
   * a retry after a failure skips the effects that took effect and runs the rest. The mail effect
   * reads the PDF the first one stored, so they never run side by side.
   */
  private async dispatch(message: QueueMessage): Promise<void> {
    switch (message.type) {
      case OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED:
        for (const effect of this.effects) await this.runEffect(effect, message);
        return;
    }
  }

  /** Counts the effect after it committed, or its failure; a message that was handled before counts nothing. */
  private async runEffect(
    effect: BookingConfirmedEffect,
    message: BookingConfirmedMessage
  ): Promise<void> {
    let tookEffect: boolean;
    try {
      tookEffect = await withSpan(
        SPAN_NAME.QUEUE_EFFECT,
        () =>
          this.outbox.processOnce(effect.consumer, message.messageId, (tx) =>
            effect.handle(message, tx)
          ),
        { attributes: { [SPAN_ATTR.EFFECT]: effect.consumer } }
      );
    } catch (error) {
      this.metrics.effectProcessed(effect.consumer, EFFECT_OUTCOME.FAILED);
      throw error;
    }
    if (tookEffect) this.metrics.effectProcessed(effect.consumer, EFFECT_OUTCOME.SUCCEEDED);
  }
}
