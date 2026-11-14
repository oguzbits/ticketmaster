import type { QueueMessage } from '@app/shared';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, isNull, min, sql } from 'drizzle-orm';

import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB, type Tx } from '../../infrastructure/database/database.module.js';
import { outboxMessages, processedMessages } from '../../infrastructure/database/schema.js';
import { MESSAGE_QUEUE, type MessageQueue } from './domain/message-queue.js';

/** The oldest unpublished row may be this old before the ready probe reports the outbox as stuck. */
export const OUTBOX_STUCK_SECONDS = 300;

/**
 * Limits of one relay run. The run holds a transaction (and the locks of its rows) while it sends,
 * and it must end before the job's next tick can matter: `deadlineMs` bounds the whole batch,
 * whatever the queue does; `statementLimitMs` bounds each query; the database ends a transaction
 * that sits idle longer than `transactionLimitMs` (a backstop behind the deadline).
 */
export const OUTBOX_RELAY_LIMITS_MS = {
  DEADLINE: 30_000,
  STATEMENT: 10_000,
  TRANSACTION: 120_000,
} as const;

/** The failure name stored for a send that did not answer before the deadline of its run. */
export const RELAY_DEADLINE_ERROR = 'RelayDeadline';

type RelayLimits = { deadlineMs: number; statementLimitMs: number; transactionLimitMs: number };

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
   * does not stop the batch. A send that has not answered when the run's deadline passes counts as
   * failed and ends the batch (the rows behind it wait for the next run), so a run always ends
   * within the deadline plus its queries: runs of one process never overlap. A crash between a
   * send and the commit, or a send abandoned at the deadline that went out after all, sends the
   * row again later: the delivery is at least once and consumers dedupe by the message ID. A
   * relay that sits idle in its transaction past `transactionLimitMs` is ended by the database.
   */
  relay(
    batchSize: number,
    limits: Partial<RelayLimits> = {}
  ): Promise<{ sent: number; failed: number }> {
    const {
      deadlineMs = OUTBOX_RELAY_LIMITS_MS.DEADLINE,
      statementLimitMs = OUTBOX_RELAY_LIMITS_MS.STATEMENT,
      transactionLimitMs = OUTBOX_RELAY_LIMITS_MS.TRANSACTION,
    } = limits;
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('idle_in_transaction_session_timeout', ${String(transactionLimitMs)}, true)`
      );
      await tx.execute(
        sql`select set_config('statement_timeout', ${String(statementLimitMs)}, true)`
      );
      const rows = await tx
        .select()
        .from(outboxMessages)
        .where(isNull(outboxMessages.publishedAt))
        .orderBy(asc(outboxMessages.createdAt))
        .limit(batchSize)
        .for('update', { skipLocked: true });
      let expired = false;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<string>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(RELAY_DEADLINE_ERROR);
        }, deadlineMs);
      });
      let sent = 0;
      let failed = 0;
      try {
        for (const row of rows) {
          if (expired) break;
          const failure = await Promise.race([
            this.send(row.id, JSON.stringify(row.payload)),
            deadline,
          ]);
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
      } finally {
        clearTimeout(timer);
      }
      return { sent, failed };
    });
  }

  /**
   * Runs `effect` once per (consumer, message ID): the pair is recorded and the effect runs in one
   * transaction, so both commit together or neither does. Returns false, without running the
   * effect, when the pair is recorded already (a duplicate delivery). A second delivery that
   * arrives while the first is still running waits for its outcome: on commit it is a duplicate, on
   * rollback it runs the effect itself.
   */
  processOnce(
    consumer: string,
    messageId: string,
    effect: (tx: Tx) => Promise<void>
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const recorded = await tx
        .insert(processedMessages)
        .values({ consumer, messageId })
        .onConflictDoNothing()
        .returning({ messageId: processedMessages.messageId });
      if (recorded.length === 0) return false;
      await effect(tx);
      return true;
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
