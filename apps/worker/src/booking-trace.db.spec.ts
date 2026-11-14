import { randomUUID } from 'node:crypto';

import { BookingsService, HOLD_OUTCOME } from '@app/api/bookings';
import { createTestEvent } from '@app/api/bookings/testing';
import { APP_CONFIG, loadEnv } from '@app/api/config';
import { type Database, DB } from '@app/api/database';
import { MESSAGE_QUEUE, OutboxService } from '@app/api/outbox';
import {
  createScratchQueue,
  createSqsClient,
  lockOutboxRelays,
  SqsMessageQueue,
} from '@app/api/outbox/testing';
import { SPAN_ATTR, SPAN_NAME, withSpan } from '@app/api/tracing';
import { startTestTracing } from '@app/api/tracing/testing';
import { BOOKING_STATUS, BOOKING_STRATEGY } from '@app/shared';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type BookingConfirmedEffect, CONSUMER_NAME } from './handlers/booking-confirmed-effect.js';
import { QueueConsumer } from './queue-consumer.js';
import { WorkerModule } from './worker.module.js';

const VISIBILITY_SECONDS = 5;
const POLL_SECONDS = 1;
const WAIT_MS = 20_000;
const EFFECTS = 2;
const ROOT_SPAN = 'test.request';
const EMAIL = /\S+@\S+/;

/** Notes the message ID of the booking it is asked about; other rows of the shared outbox pass through. */
const effect = (
  consumer: string,
  bookingId: string,
  seen: Set<string>
): BookingConfirmedEffect => ({
  consumer,
  handle: (message) => {
    if (message.bookingId === bookingId) seen.add(message.messageId);
    return Promise.resolve();
  },
});

describe('one booking is one trace', () => {
  const client = createSqsClient(loadEnv());
  let moduleRef: TestingModule;
  let destroyQueue: () => Promise<void>;
  let consumer: QueueConsumer | undefined;
  let stopTracing: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const scratch = await createScratchQueue(client, VISIBILITY_SECONDS);
    destroyQueue = scratch.destroy;
    const queue = await SqsMessageQueue.connect(client, scratch.queueName, POLL_SECONDS);
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(MESSAGE_QUEUE)
      .useValue(queue)
      .overrideProvider(APP_CONFIG)
      .useValue({ ...loadEnv(), PAYMENT_FAILURE_RATE: 0 })
      .compile();
  });
  afterEach(async () => {
    await consumer?.onModuleDestroy();
    await stopTracing?.();
  });
  afterAll(async () => {
    await moduleRef.close();
    await destroyQueue();
    client.destroy();
  });

  it('pay, relay and consumer share the trace of the request; no span attribute holds the user or an address', async () => {
    const unlock = await lockOutboxRelays(moduleRef.get<Database>(DB, { strict: false }));
    try {
      const db = moduleRef.get<Database>(DB, { strict: false });
      const bookings = moduleRef.get(BookingsService, { strict: false });
      const outbox = moduleRef.get(OutboxService, { strict: false });
      const userId = randomUUID();
      const { eventId, seatIds } = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 1,
      });
      const held = await bookings.hold({ eventId, seatId: seatIds[0] ?? '', userId });
      if (held.outcome !== HOLD_OUTCOME.PLACED) throw new Error('hold was not placed');
      const traced = startTestTracing();
      stopTracing = traced.shutdown;

      const view = await withSpan(ROOT_SPAN, () =>
        bookings.pay({ bookingId: held.bookingId, userId, idempotencyKey: randomUUID() })
      );
      await outbox.relay(1000);
      const seen = new Set<string>();
      consumer = new QueueConsumer(
        moduleRef.get(MESSAGE_QUEUE, { strict: false }),
        outbox,
        effect(CONSUMER_NAME.TICKET_PDF, held.bookingId, seen),
        effect(CONSUMER_NAME.CONFIRMATION_MAIL, held.bookingId, seen)
      );
      consumer.onModuleInit();
      const spans = () => traced.exporter.getFinishedSpans();
      const named = (name: string) => spans().filter((span) => span.name === name);
      const root = named(ROOT_SPAN)[0]?.spanContext().traceId;
      const inRoot = (name: string) =>
        named(name).filter((span) => span.spanContext().traceId === root);
      await expect.poll(() => inRoot(SPAN_NAME.QUEUE_PROCESS).length, { timeout: WAIT_MS }).toBe(1);

      expect(view.status).toBe(BOOKING_STATUS.CONFIRMED);
      expect(root).toMatch(/^[0-9a-f]{32}$/);
      expect(inRoot(SPAN_NAME.OUTBOX_SEND)).toHaveLength(1);
      expect(inRoot(SPAN_NAME.QUEUE_EFFECT)).toHaveLength(EFFECTS);
      expect(inRoot(SPAN_NAME.DB_QUERY).length).toBeGreaterThan(0);
      // The message of this booking is handled in the trace of the request, nowhere else. Other rows
      // of the shared outbox and the polls of relay and consumer have traces of their own.
      expect(seen.size).toBe(1);
      const handled = named(SPAN_NAME.QUEUE_PROCESS).filter((span) =>
        seen.has(String(span.attributes[SPAN_ATTR.MESSAGE_ID]))
      );
      expect(handled.map((span) => span.spanContext().traceId)).toEqual([root]);
      const values = spans().flatMap((span) => Object.values(span.attributes).map(String));
      expect(values.filter((value) => value.includes(userId) || EMAIL.test(value))).toEqual([]);
    } finally {
      await unlock();
    }
  });
});
