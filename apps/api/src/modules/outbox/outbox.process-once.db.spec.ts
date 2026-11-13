import { randomUUID } from 'node:crypto';

import { OUTBOX_MESSAGE_TYPE } from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { Tx } from '../../infrastructure/database/database.module.js';
import { outboxMessages, processedMessages } from '../../infrastructure/database/schema.js';
import { openTestDatabase } from '../../testing/database.js';
import { OutboxService } from './outbox.service.js';
import { FakeMessageQueue } from './testing/index.js';

const PARALLEL = 10;

describe('OutboxService.processOnce', () => {
  const database = openTestDatabase();
  const { db } = database;
  const service = new OutboxService(db, { now: () => new Date() }, new FakeMessageQueue());
  const messageIds: string[] = [];

  afterEach(async () => {
    for (const id of messageIds.splice(0)) {
      await db.delete(processedMessages).where(eq(processedMessages.messageId, id));
      await db.delete(outboxMessages).where(eq(outboxMessages.id, id));
    }
  });
  afterAll(() => database.close());

  function newMessageId(): string {
    const id = randomUUID();
    messageIds.push(id);
    return id;
  }

  async function recordedFor(messageId: string): Promise<string[]> {
    const rows = await db
      .select()
      .from(processedMessages)
      .where(eq(processedMessages.messageId, messageId));
    return rows.map((row) => row.consumer);
  }

  it('runs the effect once per consumer and message ID, the second delivery is a no-op', async () => {
    const messageId = newMessageId();
    let runs = 0;
    const effect = async () => {
      runs += 1;
    };

    const first = await service.processOnce('mail', messageId, effect);
    const second = await service.processOnce('mail', messageId, effect);
    const other = await service.processOnce('pdf', messageId, effect);

    expect([first, second, other]).toEqual([true, false, true]);
    expect(runs).toBe(2);
    expect((await recordedFor(messageId)).sort()).toEqual(['mail', 'pdf']);
  });

  it('an effect that throws leaves no record and no write of its own; the next delivery runs it', async () => {
    const messageId = newMessageId();
    const failing = async (tx: Tx) => {
      await tx.insert(outboxMessages).values({
        id: messageId,
        type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
        payload: {
          messageId,
          type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
          bookingId: randomUUID(),
          eventId: randomUUID(),
          userId: randomUUID(),
          occurredAt: new Date().toISOString(),
        },
      });
      throw new Error('handler failed');
    };

    await expect(service.processOnce('mail', messageId, failing)).rejects.toThrow('handler failed');

    expect(await recordedFor(messageId)).toEqual([]);
    expect(await db.select().from(outboxMessages).where(eq(outboxMessages.id, messageId))).toEqual(
      []
    );
    expect(await service.processOnce('mail', messageId, async () => undefined)).toBe(true);
  });

  it('parallel deliveries of one message run the effect once', async () => {
    const messageId = newMessageId();
    let runs = 0;

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        service.processOnce('mail', messageId, async () => {
          runs += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
        })
      )
    );

    expect(runs).toBe(1);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
