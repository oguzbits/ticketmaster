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
import { MAIL_SENDER, TICKET_STORE, USER_DIRECTORY } from '@app/api/tickets';
import { FakeMailSender, FakeTicketStore, FakeUserDirectory } from '@app/api/tickets/testing';
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

import {
  type BookingConfirmedEffect,
  type BookingConfirmedMessage,
  CONSUMER_NAME,
} from './handlers/booking-confirmed-effect.js';
import { ConfirmationMailHandler } from './handlers/confirmation-mail.handler.js';
import { TicketPdfHandler } from './handlers/ticket-pdf.handler.js';
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

/** Every message takes effect once per effect, under the name of each. */
const EFFECTS = 2;

/** Records every delivery; `failures` says how many deliveries of a message still fail. */
class RecordingHandler implements BookingConfirmedEffect {
  readonly attempted: string[] = [];
  readonly handled: string[] = [];
  /** Message ID by booking ID. */
  readonly byBooking = new Map<string, string>();
  readonly failures = new Map<string, number>();
  constructor(readonly consumer: string = CONSUMER_NAME.TICKET_PDF) {}
  handle(message: BookingConfirmedMessage): Promise<void> {
    this.attempted.push(message.messageId);
    const failing = this.failures.get(message.messageId) ?? 0;
    if (failing > 0) {
      this.failures.set(message.messageId, failing - 1);
      return Promise.reject(new Error('handler failed'));
    }
    this.handled.push(message.messageId);
    this.byBooking.set(message.bookingId, message.messageId);
    return Promise.resolve();
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
  const store = new FakeTicketStore();
  const mailer = new FakeMailSender();
  const directory = new FakeUserDirectory();

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
      .overrideProvider(TICKET_STORE)
      .useValue(store)
      .overrideProvider(MAIL_SENDER)
      .useValue(mailer)
      .overrideProvider(USER_DIRECTORY)
      .useValue(directory)
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

  function start(
    queue: MessageQueue,
    handler = new RecordingHandler(),
    second = new RecordingHandler(CONSUMER_NAME.CONFIRMATION_MAIL)
  ): QueueConsumer {
    const consumer = new QueueConsumer(queue, outbox, handler, second);
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
    expect(await countProcessed(db, message.messageId)).toBe(EFFECTS);
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
      // Every level: a payload in a debug line leaks as well as one in an error.
      const logged = [
        vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
        vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
        vi.spyOn(Logger.prototype, 'verbose').mockImplementation(() => undefined),
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
    // The second effect of the message commits after the first one's handler has returned.
    await expect
      .poll(() => countProcessed(db, message.messageId), { timeout: DLQ_WAIT_MS })
      .toBe(EFFECTS);
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
      await expect
        .poll(() => countProcessed(db, handler.byBooking.get(held.bookingId) ?? ''), {
          timeout: DLQ_WAIT_MS,
        })
        .toBe(EFFECTS);
    } finally {
      await unlock();
    }
  });

  describe('ticket PDF and confirmation mail', () => {
    const ADDRESS = 'dora.musterfrau@example.test';
    const RETRY_WAIT_MS = 15_000;

    /** A confirmed booking and the message that announces it; the relays stay away from its row. */
    async function confirmedBooking(): Promise<{ message: QueueMessage; userId: string }> {
      const userId = randomUUID();
      directory.addresses.set(userId, ADDRESS);
      const { eventId, seatIds } = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 1,
      });
      const held = await bookings.hold({ eventId, seatId: seatIds[0] ?? '', userId });
      if (held.outcome !== HOLD_OUTCOME.PLACED) throw new Error('hold was not placed');
      await bookings.pay({ bookingId: held.bookingId, userId, idempotencyKey: randomUUID() });
      return {
        userId,
        message: { ...confirmed(), bookingId: held.bookingId, eventId, userId },
      };
    }

    const ticketReady = async (userId: string): Promise<boolean | undefined> =>
      (await bookings.listOwn(userId))[0]?.ticketReady;

    async function withRelaysLocked(run: () => Promise<void>): Promise<void> {
      const unlock = await lockOutboxRelays(db);
      try {
        await run();
      } finally {
        await unlock();
      }
    }

    const realConsumer = (queue: MessageQueue): QueueConsumer =>
      start(queue, moduleRef.get(TicketPdfHandler), moduleRef.get(ConfirmationMailHandler));

    /** The PDF effect needs the transaction of its dedupe record: run it as the consumer would. */
    const storePdf = (message: BookingConfirmedMessage): Promise<boolean> =>
      outbox.processOnce(CONSUMER_NAME.TICKET_PDF, randomUUID(), (tx) =>
        moduleRef.get(TicketPdfHandler).handle(message, tx)
      );

    const reset = (): void => {
      store.objects.clear();
      store.hidden.clear();
      store.puts = 0;
      mailer.sent.length = 0;
      mailer.failures = 0;
      directory.failures = 0;
    };

    it('stores the PDF, marks the ticket ready and mails it once; no log line holds the address', async () => {
      reset();
      await withRelaysLocked(async () => {
        const { queue } = await scratch();
        const logged = [
          vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
          vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
          vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
        ];
        const { message, userId } = await confirmedBooking();
        const consumer = realConsumer(queue);

        await send(queue, message);
        await expect.poll(() => mailer.sent.length, { timeout: DLQ_WAIT_MS }).toBe(1);

        const stored = store.objects.get(message.bookingId);
        expect(
          Buffer.from(stored ?? [])
            .subarray(0, 4)
            .toString()
        ).toBe('%PDF');
        expect(mailer.sent[0]).toMatchObject({ to: ADDRESS });
        expect(mailer.sent[0]?.attachment.content).toEqual(stored);
        expect(await ticketReady(userId)).toBe(true);
        const lines = logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
        expect(lines.filter((line) => line.includes(ADDRESS))).toEqual([]);
        expect(await leftOver(queue, consumer)).toEqual([]);
      });
    });

    it('a message that arrives twice yields one PDF and one mail', async () => {
      reset();
      await withRelaysLocked(async () => {
        const { queue } = await scratch();
        const { message } = await confirmedBooking();
        const consumer = realConsumer(queue);

        await send(queue, message);
        await send(queue, message);
        await expect.poll(() => mailer.sent.length, { timeout: DLQ_WAIT_MS }).toBe(1);
        await sleep(SETTLE_MS);

        expect(store.puts).toBe(1);
        expect(mailer.sent).toHaveLength(1);
        expect(await countProcessed(db, message.messageId)).toBe(EFFECTS);
        expect(await leftOver(queue, consumer)).toEqual([]);
      });
    });

    it('a booking that was cancelled before the message is handled gets no PDF and no mail, and the message is deleted', async () => {
      reset();
      await withRelaysLocked(async () => {
        const { queue } = await scratch();
        const { message, userId } = await confirmedBooking();
        await bookings.cancel({ bookingId: message.bookingId, userId });
        const consumer = realConsumer(queue);

        await send(queue, message);
        await expect
          .poll(() => countProcessed(db, message.messageId), { timeout: DLQ_WAIT_MS })
          .toBe(EFFECTS);

        expect(store.puts).toBe(0);
        expect(mailer.sent).toEqual([]);
        expect(await ticketReady(userId)).toBe(false);
        expect(await leftOver(queue, consumer)).toEqual([]);
      });
    });

    it(
      'an address lookup that fails leaves the message in the queue; the retry sends the mail without storing the PDF again',
      async () => {
        reset();
        await withRelaysLocked(async () => {
          const { queue } = await scratch();
          const { message } = await confirmedBooking();
          directory.failures = 1;
          const consumer = realConsumer(queue);

          await send(queue, message);
          await expect.poll(() => mailer.sent.length, { timeout: RETRY_WAIT_MS }).toBe(1);

          expect(store.puts).toBe(1);
          expect(await leftOver(queue, consumer)).toEqual([]);
        });
      },
      SLOW_TEST_MS
    );

    it(
      'a mail server that is down leaves the message in the queue; the retry sends one mail without storing the PDF again',
      async () => {
        reset();
        await withRelaysLocked(async () => {
          const { queue } = await scratch();
          const { message } = await confirmedBooking();
          mailer.failures = 1;
          const consumer = realConsumer(queue);

          await send(queue, message);
          await expect.poll(() => mailer.sent.length, { timeout: RETRY_WAIT_MS }).toBe(1);

          expect(store.puts).toBe(1);
          expect(await leftOver(queue, consumer)).toEqual([]);
        });
      },
      SLOW_TEST_MS
    );

    it('a user without an address gets no mail: the effect fails and records nothing', async () => {
      reset();
      await withRelaysLocked(async () => {
        const { message, userId } = await confirmedBooking();
        directory.addresses.delete(userId);
        const mail = moduleRef.get(ConfirmationMailHandler);
        await storePdf(message);

        await expect(mail.handle(message)).rejects.toThrow(/no email/);

        expect(mailer.sent).toEqual([]);
      });
    });

    it('a stored PDF that cannot be read back fails the mail instead of sending it without the attachment', async () => {
      reset();
      await withRelaysLocked(async () => {
        const { message } = await confirmedBooking();
        await storePdf(message);
        store.hidden.add(message.bookingId);

        await expect(moduleRef.get(ConfirmationMailHandler).handle(message)).rejects.toThrow(
          /ticket/
        );

        expect(mailer.sent).toEqual([]);
      });
    });
  });
});
