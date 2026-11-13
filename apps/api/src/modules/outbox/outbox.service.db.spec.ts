import { randomUUID } from 'node:crypto';

import { OUTBOX_MESSAGE_TYPE, type QueueMessage, QueueMessageSchema } from '@app/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../../core/clock.js';
import type { Database } from '../../infrastructure/database/database.module.js';
import { outboxMessages } from '../../infrastructure/database/schema.js';
import { openTestDatabase } from '../../testing/database.js';
import { OutboxService } from './outbox.service.js';
import { FakeMessageQueue } from './testing/index.js';

// The relay takes every unpublished row of the table, and the other db specs share it. So these
// specs use rows with random IDs, a batch size that reaches past foreign rows, and judge only the
// rows they wrote. The clock stands in the year 2000, before any real row, so the oldest
// unpublished row is always one of this file's.
const CLOCK_TIME = new Date('2000-01-01T12:00:00.000Z');
const BATCH = 1000;
const GATE_WAIT_MS = 3000;

class QueueDown extends Error {
  override name = 'QueueDown';
}

function message(): QueueMessage {
  return {
    messageId: randomUUID(),
    type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
    bookingId: randomUUID(),
    eventId: randomUUID(),
    userId: randomUUID(),
    occurredAt: CLOCK_TIME.toISOString(),
  };
}

describe('OutboxService', () => {
  const database = openTestDatabase();
  const db: Database = database.db;
  const clock: Clock = { now: () => CLOCK_TIME };
  const written: string[] = [];

  afterEach(async () => {
    if (written.length > 0)
      await db.delete(outboxMessages).where(inArray(outboxMessages.id, written));
    written.length = 0;
  });
  afterAll(() => database.close());

  function serviceWith(queue: FakeMessageQueue, at: Clock = clock): OutboxService {
    return new OutboxService(db, at, queue);
  }

  /** Stores messages through `enqueue`, the way a booking does. */
  async function enqueueMessages(service: OutboxService, count: number): Promise<QueueMessage[]> {
    const messages = Array.from({ length: count }, message);
    written.push(...messages.map((m) => m.messageId));
    await db.transaction(async (tx) => {
      for (const m of messages) await service.enqueue(tx, m);
    });
    return messages;
  }

  async function rowOf(messageId: string) {
    const [row] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, messageId));
    if (row === undefined) throw new Error(`no outbox row ${messageId}`);
    return row;
  }

  it('enqueue inside a transaction that rolls back leaves no row', async () => {
    const service = serviceWith(new FakeMessageQueue());
    const rolledBack = message();

    await expect(
      db.transaction(async (tx) => {
        await service.enqueue(tx, rolledBack);
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');

    const rows = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, rolledBack.messageId));
    expect(rows).toEqual([]);
  });

  it('relay sends each unpublished row once with the row ID and marks it published', async () => {
    const queue = new FakeMessageQueue();
    const service = serviceWith(queue);
    const [first, second] = await enqueueMessages(service, 2);
    if (first === undefined || second === undefined) throw new Error('no messages');

    await service.relay(BATCH);
    await service.relay(BATCH);

    expect(queue.sentCount(first.messageId)).toBe(1);
    expect(queue.sentCount(second.messageId)).toBe(1);
    const body = queue.sent.find((input) => input.messageId === first.messageId)?.body;
    expect(QueueMessageSchema.parse(JSON.parse(body ?? ''))).toEqual(first);
    expect(await rowOf(first.messageId)).toMatchObject({ publishedAt: CLOCK_TIME, attempts: 0 });
  });

  it('relay stops at the batch size', async () => {
    const service = serviceWith(new FakeMessageQueue());
    await enqueueMessages(service, 3);

    const result = await service.relay(1);

    expect(result.sent + result.failed).toBe(1);
  });

  it('a failed send keeps the row, counts the attempt, stores the error name only, and the next relay delivers it', async () => {
    let down = true;
    const queue = new FakeMessageQueue(async () => {
      if (down) throw new QueueDown('contains user@example.org');
    });
    const service = serviceWith(queue);
    const [only] = await enqueueMessages(service, 1);
    if (only === undefined) throw new Error('no message');

    await service.relay(BATCH);

    expect(await rowOf(only.messageId)).toMatchObject({
      publishedAt: null,
      attempts: 1,
      lastError: 'QueueDown',
    });

    down = false;
    await service.relay(BATCH);

    expect(await rowOf(only.messageId)).toMatchObject({ publishedAt: CLOCK_TIME, attempts: 1 });
    expect(queue.sentCount(only.messageId)).toBe(1);
  });

  it('one failing row does not block the others', async () => {
    const bad = message();
    const queue = new FakeMessageQueue(async (input) => {
      if (input.messageId === bad.messageId) throw new QueueDown('rejected');
    });
    const service = serviceWith(queue);
    const others = await enqueueMessages(service, 2);
    written.push(bad.messageId);
    await db.transaction((tx) => service.enqueue(tx, bad));

    const result = await service.relay(BATCH);

    expect(result.failed).toBe(1);
    expect(await rowOf(bad.messageId)).toMatchObject({ publishedAt: null, attempts: 1 });
    for (const other of others) {
      expect(await rowOf(other.messageId)).toMatchObject({ publishedAt: CLOCK_TIME });
    }
  });

  it('a relay whose send hangs past the transaction limit fails and keeps the row for the next relay', async () => {
    const hangMs = 1500;
    const limitMs = 300;
    const hung = new FakeMessageQueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, hangMs));
    });
    const [only] = await enqueueMessages(serviceWith(hung), 1);
    if (only === undefined) throw new Error('no message');

    // The database ends a transaction that sits idle for longer than the limit.
    await expect(serviceWith(hung).relay(BATCH, limitMs)).rejects.toThrow();

    expect(await rowOf(only.messageId)).toMatchObject({ publishedAt: null });
    const healthy = new FakeMessageQueue();
    await serviceWith(healthy).relay(BATCH);
    expect(healthy.sentCount(only.messageId)).toBe(1);
  });

  it('two relays at once: the second does not wait for the rows of the first and no row goes out twice', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockedQueue = new FakeMessageQueue(() => gate);
    const freeQueue = new FakeMessageQueue();
    const [early] = await enqueueMessages(serviceWith(blockedQueue), 2);
    if (early === undefined) throw new Error('no message');
    const blocked = serviceWith(blockedQueue).relay(BATCH);
    try {
      // The first relay holds the early rows (locked, sending) while the gate is shut.
      await waitUntil(() => blockedQueue.attempted.some((i) => i.messageId === early.messageId));
      const late = await enqueueMessages(serviceWith(freeQueue), 2);

      // Without SKIP LOCKED this call waits for the locks of the first relay: the race times out.
      await withinTimeout(serviceWith(freeQueue).relay(BATCH));

      for (const m of late) expect(freeQueue.sentCount(m.messageId)).toBe(1);
      expect(freeQueue.attempted.some((i) => i.messageId === early.messageId)).toBe(false);
    } finally {
      release();
    }
    await blocked;
    expect(blockedQueue.sentCount(early.messageId)).toBe(1);
  });

  it('a crash between send and mark sends the same message ID again after the restart', async () => {
    const queue = new FakeMessageQueue();
    const service = serviceWith(queue);
    const [only] = await enqueueMessages(service, 1);
    if (only === undefined) throw new Error('no message');
    let crashed = false;
    // The mark of this file's row fails once, after its message went out; a foreign row is marked normally.
    const crashOnMark: Clock = {
      now: () => {
        if (!crashed && queue.sentCount(only.messageId) === 1) {
          crashed = true;
          throw new Error('crash before the mark');
        }
        return CLOCK_TIME;
      },
    };

    await expect(serviceWith(queue, crashOnMark).relay(BATCH)).rejects.toThrow(
      'crash before the mark'
    );
    expect(await rowOf(only.messageId)).toMatchObject({ publishedAt: null });
    await serviceWith(queue, crashOnMark).relay(BATCH);

    // At least once: the queue got it twice, consumers dedupe by the message ID.
    expect(queue.sentCount(only.messageId)).toBe(2);
    expect(await rowOf(only.messageId)).toMatchObject({ publishedAt: CLOCK_TIME });
  });

  it('oldestUnpublishedAgeSeconds is the age of the oldest unpublished row; published rows do not count', async () => {
    const service = serviceWith(new FakeMessageQueue());
    const ageSeconds = (seconds: number) => new Date(CLOCK_TIME.getTime() - seconds * 1000);
    const [old, young, published] = [message(), message(), message()];
    written.push(old.messageId, young.messageId, published.messageId);
    await db.insert(outboxMessages).values([
      { id: old.messageId, type: old.type, payload: old, createdAt: ageSeconds(120) },
      { id: young.messageId, type: young.type, payload: young, createdAt: ageSeconds(10) },
      {
        id: published.messageId,
        type: published.type,
        payload: published,
        createdAt: ageSeconds(500),
        publishedAt: ageSeconds(400),
      },
    ]);

    expect(await service.oldestUnpublishedAgeSeconds()).toBe(120);
  });
});

/** Rejects when `work` does not finish within GATE_WAIT_MS. */
async function withinTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('still waiting for the rows of another relay')),
      GATE_WAIT_MS
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls until `condition` holds; the spec fails when it does not within GATE_WAIT_MS. */
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + GATE_WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
