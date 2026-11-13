import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { BookingsService, HOLD_OUTCOME } from '@app/api/bookings';
import { createTestEvent } from '@app/api/bookings/testing';
import { APP_CONFIG, loadEnv } from '@app/api/config';
import { type Database, DB } from '@app/api/database';
import { MESSAGE_QUEUE, type MessageQueue, OutboxService } from '@app/api/outbox';
import {
  countProcessed,
  createScratchQueueWithDlq,
  createSqsClient,
  lockOutboxRelays,
  SqsMessageQueue,
} from '@app/api/outbox/testing';
import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  OUTBOX_MESSAGE_TYPE,
  QUEUE_POLICY,
  type QueueMessage,
} from '@app/shared';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BookingConfirmedHandler } from './handlers/booking-confirmed.handler.js';
import { QueueConsumer } from './queue-consumer.js';
import { WorkerModule } from './worker.module.js';

// A queue of its own per test, with its own dead-letter queue and the production receive limit.
// Messages that were not deleted come back after the visibility timeout.
const VISIBILITY_SECONDS = 1;
const POLL_SECONDS = 1;
const ERROR_PAUSE_MS = 50;
const SETTLE_MS = (VISIBILITY_SECONDS + 0.5) * 1000;
const DLQ_WAIT_MS = 20_000;
const SLOW_TEST_MS = 30_000;
const PROMPT_MS = 2000;
const SECRET = 'top-secret-payload';

/** Records every delivery; `failures` says how many deliveries of a message still fail. */
class RecordingHandler extends BookingConfirmedHandler {
  readonly attempted: string[] = [];
  readonly handled: string[] = [];
  /** Message ID by booking ID. */
  readonly byBooking = new Map<string, string>();
  readonly failures = new Map<string, number>();
  override async handle(message: Parameters<BookingConfirmedHandler['handle']>[0]): Promise<void> {
    this.attempted.push(message.messageId);
    const failing = this.failures.get(message.messageId) ?? 0;
    if (failing > 0) {
      this.failures.set(message.messageId, failing - 1);
      throw new Error('handler failed');
    }
    await super.handle(message);
    this.handled.push(message.messageId);
    this.byBooking.set(message.bookingId, message.messageId);
  }
}

function confirmed(): QueueMessage {
  return {
    messageId: randomUUID(),
    type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
    bookingId: randomUUID(),
    eventId: randomUUID(),
    userId: randomUUID(),
    occurredAt: new Date().toISOString(),
  };
}

describe('QueueConsumer against the local emulator', () => {
  const client = createSqsClient(loadEnv());
  const cleanup: (() => Promise<void>)[] = [];
  const running: QueueConsumer[] = [];
  let moduleRef: TestingModule;
  let db: Database;
  let outbox: OutboxService;
  let bookings: BookingsService;
  let moduleQueue: MessageQueue;

  async function scratch(pollSeconds = POLL_SECONDS) {
    const scratchQueue = await createScratchQueueWithDlq(
      client,
      VISIBILITY_SECONDS,
      QUEUE_POLICY.MAX_RECEIVE_COUNT
    );
    cleanup.push(scratchQueue.destroy);
    return {
      queue: await SqsMessageQueue.connect(client, scratchQueue.queueName, pollSeconds),
      dlq: await SqsMessageQueue.connect(client, scratchQueue.dlqName, POLL_SECONDS),
    };
  }

  beforeAll(async () => {
    moduleQueue = (await scratch()).queue;
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(MESSAGE_QUEUE)
      .useValue(moduleQueue)
      // Every payment succeeds: the full path needs a confirmed booking.
      .overrideProvider(APP_CONFIG)
      .useValue({ ...loadEnv(), PAYMENT_FAILURE_RATE: 0 })
      .compile();
    db = moduleRef.get<Database>(DB, { strict: false });
    outbox = moduleRef.get(OutboxService, { strict: false });
    bookings = moduleRef.get(BookingsService, { strict: false });
  });
  afterEach(async () => {
    await Promise.all(running.splice(0).map((consumer) => consumer.onModuleDestroy()));
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await moduleRef.close();
    for (const destroy of cleanup.splice(0)) await destroy();
    client.destroy();
  });

  function start(queue: MessageQueue, handler = new RecordingHandler()): QueueConsumer {
    const consumer = new QueueConsumer(queue, outbox, handler);
    consumer.errorPauseMs = ERROR_PAUSE_MS;
    consumer.onModuleInit();
    running.push(consumer);
    return consumer;
  }

  const send = (queue: MessageQueue, message: QueueMessage) =>
    queue.send({ body: JSON.stringify(message), messageId: message.messageId });

  /** The message IDs that reach the dead-letter queue, until `count` of them have. */
  async function inDlq(dlq: MessageQueue, count: number): Promise<string[]> {
    const seen = new Set<string>();
    const deadline = Date.now() + DLQ_WAIT_MS;
    while (seen.size < count && Date.now() < deadline) {
      for (const received of await dlq.receive(10)) seen.add(received.messageId);
    }
    return [...seen];
  }

  /** Stops the consumer and waits past the visibility timeout: what is left was not deleted. */
  async function leftOver(queue: MessageQueue, consumer: QueueConsumer) {
    await consumer.onModuleDestroy();
    await sleep(SETTLE_MS);
    return queue.receive(10);
  }

  it('hands a message to the handler once; the same message ID sent twice takes effect once and both are deleted', async () => {
    const { queue } = await scratch();
    const handler = new RecordingHandler();
    const consumer = start(queue, handler);
    const message = confirmed();

    await send(queue, message);
    await send(queue, message);
    await expect.poll(() => handler.handled, { timeout: DLQ_WAIT_MS }).toEqual([message.messageId]);
    await sleep(SETTLE_MS);

    expect(handler.attempted).toEqual([message.messageId]);
    expect(await countProcessed(db, message.messageId)).toBe(1);
    expect(await leftOver(queue, consumer)).toEqual([]);
  });

  it(
    'a handler that keeps failing leaves the message undeleted until the dead-letter queue takes it; nothing is recorded',
    async () => {
      const { queue, dlq } = await scratch();
      const handler = new RecordingHandler();
      const message = confirmed();
      handler.failures.set(message.messageId, Infinity);
      const consumer = start(queue, handler);

      await send(queue, message);

      expect(await inDlq(dlq, 1)).toEqual([message.messageId]);
      expect(handler.attempted).toHaveLength(QUEUE_POLICY.MAX_RECEIVE_COUNT);
      expect(await countProcessed(db, message.messageId)).toBe(0);
      expect(await leftOver(queue, consumer)).toEqual([]);
    },
    SLOW_TEST_MS
  );

  it(
    'a body that does not parse ends in the dead-letter queue without its payload in the log; the loop goes on with the next message',
    async () => {
      const { queue, dlq } = await scratch();
      const handler = new RecordingHandler();
      const logged = [
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      ];
      const consumer = start(queue, handler);
      const notJson = randomUUID();
      const wrongShape = randomUUID();
      await queue.send({ body: `not json ${SECRET}`, messageId: notJson });
      await queue.send({
        body: JSON.stringify({ type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED, secret: SECRET }),
        messageId: wrongShape,
      });
      const next = confirmed();
      await send(queue, next);

      await expect.poll(() => handler.handled, { timeout: DLQ_WAIT_MS }).toEqual([next.messageId]);
      expect((await inDlq(dlq, 2)).sort()).toEqual([notJson, wrongShape].sort());

      const lines = logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
      expect(lines.some((line) => line.includes(notJson))).toBe(true);
      expect(lines.filter((line) => line.includes(SECRET))).toEqual([]);
      expect(await leftOver(queue, consumer)).toEqual([]);
    },
    SLOW_TEST_MS
  );

  it('a handler that fails on the first delivery and succeeds on the second takes effect once', async () => {
    const { queue } = await scratch();
    const handler = new RecordingHandler();
    const message = confirmed();
    handler.failures.set(message.messageId, 1);
    const consumer = start(queue, handler);

    await send(queue, message);
    await expect.poll(() => handler.handled, { timeout: DLQ_WAIT_MS }).toEqual([message.messageId]);

    expect(handler.attempted).toEqual([message.messageId, message.messageId]);
    expect(await countProcessed(db, message.messageId)).toBe(1);
    expect(await leftOver(queue, consumer)).toEqual([]);
  });

  it('stops promptly while a long poll is open', async () => {
    const { queue } = await scratch(QUEUE_POLICY.LONG_POLL_SECONDS);
    const consumer = start(queue);
    await sleep(300);

    const started = Date.now();
    await consumer.onModuleDestroy();

    expect(Date.now() - started).toBeLessThan(PROMPT_MS);
  });

  it('full path: a confirmed booking is relayed to the queue and recorded by the consumer once', async () => {
    const unlock = await lockOutboxRelays(db);
    try {
      const userId = randomUUID();
      const { eventId, seatIds } = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 1,
      });
      const [seatId] = seatIds;
      if (seatId === undefined) throw new Error('test event has no seat');
      const held = await bookings.hold({ eventId, seatId, userId });
      if (held.outcome !== HOLD_OUTCOME.PLACED) throw new Error('hold was not placed');
      const view = await bookings.pay({
        bookingId: held.bookingId,
        userId,
        idempotencyKey: randomUUID(),
      });
      const handler = new RecordingHandler();
      start(moduleQueue, handler);

      await outbox.relay(1000);

      expect(view.status).toBe(BOOKING_STATUS.CONFIRMED);
      await expect
        .poll(() => handler.byBooking.has(held.bookingId), { timeout: DLQ_WAIT_MS })
        .toBe(true);
      expect(await countProcessed(db, handler.byBooking.get(held.bookingId) ?? '')).toBe(1);
    } finally {
      await unlock();
    }
  });
});
