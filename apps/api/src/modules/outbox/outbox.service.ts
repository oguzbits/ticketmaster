import type { QueueMessage } from '@app/shared';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, isNull, min, sql } from 'drizzle-orm';

import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB, type Tx } from '../../infrastructure/database/database.module.js';
import { outboxMessages } from '../../infrastructure/database/schema.js';
import { MESSAGE_QUEUE, type MessageQueue } from './domain/message-queue.js';

/** The oldest unpublished row may be this old before the ready probe reports the outbox as stuck. */
export const OUTBOX_STUCK_SECONDS = 300;

/**
 * The relay holds its transaction (and the locks of its rows) while it sends. The database ends a
 * transaction that sits idle longer than this: a batch of sends, each bounded by the request
 * timeout of the queue client (5 s), stays far below it.
 */
export const OUTBOX_RELAY_TRANSACTION_LIMIT_MS = 120_000;

@Injectable()
export class OutboxService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MESSAGE_QUEUE) private readonly queue: MessageQueue
  ) {}

  /**
   * Stores a message in the transaction of the change it announces: the row exists if and only if
   * that change committed. The row ID is the message ID.
   */
  async enqueue(tx: Tx, message: QueueMessage): Promise<void> {
    await tx
      .insert(outboxMessages)
      .values({ id: message.messageId, type: message.type, payload: message });
  }

  /**
   * Sends the oldest unpublished rows and marks the sent ones published, in one transaction. Rows
   * another relay holds are skipped, so relays side by side never wait for each other and send
   * each row once. A failed send keeps its row, counts the attempt and stores the error name; it
   * does not stop the batch. A crash between a send and the commit sends the row again later: the
   * delivery is at least once and consumers dedupe by the message ID. A relay that sits idle in
   * its transaction past `transactionLimitMs` (a send that hangs) is ended by the database: it
   * rejects, its rows stay unpublished and the sends it made are repeated by the next relay.
   */
  relay(
    batchSize: number,
    transactionLimitMs: number = OUTBOX_RELAY_TRANSACTION_LIMIT_MS
  ): Promise<{ sent: number; failed: number }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('idle_in_transaction_session_timeout', ${String(transactionLimitMs)}, true)`
      );
      const rows = await tx
        .select()
        .from(outboxMessages)
        .where(isNull(outboxMessages.publishedAt))
        .orderBy(asc(outboxMessages.createdAt))
        .limit(batchSize)
        .for('update', { skipLocked: true });
      let sent = 0;
      let failed = 0;
      for (const row of rows) {
        const failure = await this.send(row.id, JSON.stringify(row.payload));
        if (failure === null) {
          await tx
            .update(outboxMessages)
            .set({ publishedAt: this.clock.now() })
            .where(eq(outboxMessages.id, row.id));
          sent += 1;
        } else {
          await tx
            .update(outboxMessages)
            .set({ attempts: sql`${outboxMessages.attempts} + 1`, lastError: failure })
            .where(eq(outboxMessages.id, row.id));
          failed += 1;
        }
      }
      return { sent, failed };
    });
  }

  /** Seconds since the oldest unpublished row was written; null when every row is published. */
  async oldestUnpublishedAgeSeconds(): Promise<number | null> {
    const [row] = await this.db
      .select({ oldest: min(outboxMessages.createdAt) })
      .from(outboxMessages)
      .where(isNull(outboxMessages.publishedAt));
    if (row?.oldest == null) return null;
    return (this.clock.now().getTime() - row.oldest.getTime()) / 1000;
  }

  /** The error name of a failed send, or null. Names only: a message text may hold data. */
  private async send(messageId: string, body: string): Promise<string | null> {
    try {
      await this.queue.send({ body, messageId });
      return null;
    } catch (error) {
      return error instanceof Error ? error.name : 'UnknownError';
    }
  }
}
