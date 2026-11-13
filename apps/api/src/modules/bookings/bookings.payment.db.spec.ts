import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  OUTBOX_MESSAGE_TYPE,
  type QueueMessage,
  QueueMessageSchema,
  TRANSITION_REASON,
} from '@app/shared';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';
import type { Tx } from '../../infrastructure/database/database.module.js';
import {
  bookings,
  bookingTransitions,
  outboxMessages,
} from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import { OutboxService } from '../outbox/index.js';
import { FakeMessageQueue } from '../outbox/testing/index.js';
import type { BookingsService } from './bookings.service.js';
import type { PaymentProvider } from './domain/payment-provider.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';

const NOW = SPEC_NOW;
const SEAT_PRICE_CENTS = 1000;
const PARALLEL_CHARGE_MS = 200;
// The key column is unique over the whole table, so every run needs fresh keys.
const RUN_ID = randomUUID();
const key = (name: string): string => `${RUN_ID}-${name}`;

class RecordingProvider implements PaymentProvider {
  readonly calls: Parameters<PaymentProvider['charge']>[0][] = [];
  succeed = true;
  chargeDelayMs = 0;
  /** Runs inside the charge, while the provider is "talking to the network". */
  duringCharge: (input: Parameters<PaymentProvider['charge']>[0]) => Promise<void> = async () => {};
  /** The next charge throws instead of answering (the provider is down, the process dies). */
  failNext = false;
  async charge(input: Parameters<PaymentProvider['charge']>[0]): Promise<{ succeeded: boolean }> {
    this.calls.push(input);
    await this.duringCharge(input);
    await delay(this.chargeDelayMs);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('provider down');
    }
    return { succeeded: this.succeed };
  }
}

/** Writes the row, then dies once: the crash of the apply step after its last write. */
class CrashingOutbox extends OutboxService {
  crashNext = false;
  override async enqueue(tx: Tx, message: QueueMessage): Promise<void> {
    await super.enqueue(tx, message);
    if (this.crashNext) {
      this.crashNext = false;
      throw new Error('apply crashed');
    }
  }
}

describe('payment and cancel', () => {
  const database = openTestDatabase();
  const { db } = database;
  const env = loadEnv();
  const provider = new RecordingProvider();
  let now = NOW;
  let redis: Redis;
  let service: BookingsService;
  let outbox: CrashingOutbox;

  beforeAll(async () => {
    redis = await openTestRedis();
    const clock = { now: () => now };
    outbox = new CrashingOutbox(db, clock, new FakeMessageQueue());
    service = createBookingsService(db, redis, clock, provider, undefined, outbox);
  });
  afterAll(async () => {
    await redis.quit();
    await database.close();
  });

  async function heldBooking(): Promise<{
    bookingId: string;
    userId: string;
    eventId: string;
    seatId: string;
  }> {
    now = NOW;
    provider.calls.length = 0;
    provider.succeed = true;
    provider.chargeDelayMs = 0;
    provider.failNext = false;
    outbox.crashNext = false;
    provider.duringCharge = async () => {};
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');
    const userId = randomUUID();
    const result = await service.hold({ eventId, seatId, userId });
    if (result.outcome !== HOLD_OUTCOME.PLACED) throw new Error('hold was not placed');
    return { bookingId: result.bookingId, userId, eventId, seatId };
  }

  async function transitionsOf(bookingId: string): Promise<string[]> {
    const rows = await db
      .select()
      .from(bookingTransitions)
      .where(eq(bookingTransitions.bookingId, bookingId));
    return rows.map((row) => `${row.fromStatus}>${row.toStatus}`).sort();
  }

  it('pays a held booking and confirms it with HELD→PAID→CONFIRMED transitions', async () => {
    const { bookingId, userId } = await heldBooking();

    const view = await service.pay({ bookingId, userId, idempotencyKey: key('1') });

    expect(view.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toEqual([
      { bookingId, amountCents: SEAT_PRICE_CENTS, idempotencyKey: key('1') },
    ]);
    expect(await transitionsOf(bookingId)).toEqual(
      [
        `null>${BOOKING_STATUS.HELD}`,
        `${BOOKING_STATUS.HELD}>${BOOKING_STATUS.PAID}`,
        `${BOOKING_STATUS.PAID}>${BOOKING_STATUS.CONFIRMED}`,
      ].sort()
    );
  });

  it('a confirmed payment writes one outbox row with IDs only, a failed one writes none', async () => {
    const paid = await heldBooking();
    await service.pay({ ...paid, idempotencyKey: key('row-ok') });
    const failed = await heldBooking();
    provider.succeed = false;
    await service.pay({ ...failed, idempotencyKey: key('row-fail') });

    const [row, ...more] = await outboxRowsOf(paid.bookingId);

    expect(more).toEqual([]);
    expect(row?.type).toBe(OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED);
    expect(row?.payload).toEqual({
      messageId: row?.id,
      type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
      bookingId: paid.bookingId,
      eventId: paid.eventId,
      userId: paid.userId,
      occurredAt: NOW.toISOString(),
    });
    expect(QueueMessageSchema.safeParse(row?.payload).success).toBe(true);
    expect(await outboxRowsOf(failed.bookingId)).toEqual([]);
  });

  it('an apply step that dies after writing the row rolls everything back; the retry confirms once with one row', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('crash-apply');
    outbox.crashNext = true;

    await expect(service.pay({ bookingId, userId, idempotencyKey })).rejects.toThrow(
      'apply crashed'
    );
    const afterCrash = {
      status: (await rowOf(bookingId)).status,
      transitions: await transitionsOf(bookingId),
      rows: await outboxRowsOf(bookingId),
    };
    const retried = await service.pay({ bookingId, userId, idempotencyKey });

    expect(afterCrash).toEqual({
      status: BOOKING_STATUS.HELD,
      transitions: [`null>${BOOKING_STATUS.HELD}`],
      rows: [],
    });
    expect(retried.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toHaveLength(2);
    expect(await outboxRowsOf(bookingId)).toHaveLength(1);
  });

  it('a failed charge cancels with PAYMENT_FAILED', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.succeed = false;

    const view = await service.pay({ bookingId, userId, idempotencyKey: key('2') });

    expect(view.status).toBe(BOOKING_STATUS.CANCELLED);
    const [record] = await db
      .select()
      .from(bookingTransitions)
      .where(
        and(
          eq(bookingTransitions.bookingId, bookingId),
          eq(bookingTransitions.toStatus, BOOKING_STATUS.CANCELLED)
        )
      );
    expect(record).toMatchObject({
      fromStatus: BOOKING_STATUS.HELD,
      reason: TRANSITION_REASON.PAYMENT_FAILED,
      actorId: userId,
    });
  });

  it('a key another booking already used is a conflict and is not charged', async () => {
    const first = await heldBooking();
    await service.pay({ ...first, idempotencyKey: key('shared') });
    const second = await heldBooking();

    await expect(service.pay({ ...second, idempotencyKey: key('shared') })).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(provider.calls).toHaveLength(0);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, second.bookingId));
    expect(row?.status).toBe(BOOKING_STATUS.HELD);
  });

  /** The rows of this booking only: the table is shared with other specs. */
  async function outboxRowsOf(bookingId: string) {
    return db
      .select()
      .from(outboxMessages)
      .where(sql`${outboxMessages.payload}->>'bookingId' = ${bookingId}`);
  }

  async function rowOf(bookingId: string) {
    const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    if (row === undefined) throw new Error('booking row is missing');
    return row;
  }

  it('the charge runs with the key committed and the booking row unlocked', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('outside');
    const seen: { claimedKey: string | null; lockError: string | null }[] = [];
    provider.duringCharge = async () => {
      const claimedKey = (await rowOf(bookingId)).paymentIdempotencyKey;
      // NOWAIT fails at once when another transaction holds the row: the claim transaction is over.
      let lockError: string | null = null;
      try {
        await db.transaction((tx) =>
          tx
            .select({ id: bookings.id })
            .from(bookings)
            .where(eq(bookings.id, bookingId))
            .for('update', { noWait: true })
        );
      } catch (error) {
        lockError = error instanceof Error ? error.message : 'unknown';
      }
      seen.push({ claimedKey, lockError });
    };

    await service.pay({ bookingId, userId, idempotencyKey });

    expect(seen).toEqual([{ claimedKey: idempotencyKey, lockError: null }]);
  });

  it('a charge that throws leaves the key claimed; the retry with the same key charges again and confirms', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('crash-charge');
    provider.failNext = true;

    await expect(service.pay({ bookingId, userId, idempotencyKey })).rejects.toThrow(
      'provider down'
    );
    const afterCrash = await rowOf(bookingId);
    const retried = await service.pay({ bookingId, userId, idempotencyKey });

    expect(afterCrash).toMatchObject({
      status: BOOKING_STATUS.HELD,
      paymentIdempotencyKey: idempotencyKey,
    });
    expect(retried.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toHaveLength(2);
    expect(await transitionsOf(bookingId)).toHaveLength(3);
  });

  it('ten parallel payments with one key charge once and all answer CONFIRMED', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('ten');
    provider.chargeDelayMs = PARALLEL_CHARGE_MS;

    const views = await Promise.all(
      Array.from({ length: 10 }, () => service.pay({ bookingId, userId, idempotencyKey }))
    );

    expect(new Set(views.map((view) => view.status))).toEqual(new Set([BOOKING_STATUS.CONFIRMED]));
    expect(provider.calls).toHaveLength(1);
    expect(await transitionsOf(bookingId)).toHaveLength(3);
    expect(await outboxRowsOf(bookingId)).toHaveLength(1);
  });

  it('two instances paying with one key at once apply the result once and answer alike', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('instances');
    provider.chargeDelayMs = PARALLEL_CHARGE_MS;
    const other = createBookingsService(db, redis, { now: () => now }, provider, undefined, outbox);

    const views = await Promise.all([
      service.pay({ bookingId, userId, idempotencyKey }),
      other.pay({ bookingId, userId, idempotencyKey }),
    ]);

    // Each instance may call the provider; a real one answers a repeated key with the first result.
    expect(views.map((view) => view.status)).toEqual([
      BOOKING_STATUS.CONFIRMED,
      BOOKING_STATUS.CONFIRMED,
    ]);
    expect(await transitionsOf(bookingId)).toHaveLength(3);
    expect(await outboxRowsOf(bookingId)).toHaveLength(1);
  });

  it('ten parallel payments with different keys on one booking: one wins, the others conflict', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.chargeDelayMs = PARALLEL_CHARGE_MS;

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        service.pay({ bookingId, userId, idempotencyKey: key(`many-${i}`) })
      )
    );

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.map((result) => result.reason)).toEqual(
      Array.from({ length: 9 }, () => expect.any(ConflictException))
    );
    expect(provider.calls).toHaveLength(1);
    expect((await rowOf(bookingId)).status).toBe(BOOKING_STATUS.CONFIRMED);
  });

  it('a booking cancelled during the charge is not paid over: conflict, still CANCELLED', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.duringCharge = async () => {
      await service.cancel({ bookingId, userId });
    };

    await expect(
      service.pay({ bookingId, userId, idempotencyKey: key('cancel-during') })
    ).rejects.toBeInstanceOf(ConflictException);

    expect((await rowOf(bookingId)).status).toBe(BOOKING_STATUS.CANCELLED);
    expect(await transitionsOf(bookingId)).toHaveLength(2);
  });

  it('the same key after a failed charge returns CANCELLED and does not charge again', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.succeed = false;
    await service.pay({ bookingId, userId, idempotencyKey: key('3') });
    provider.succeed = true;

    const again = await service.pay({ bookingId, userId, idempotencyKey: key('3') });

    expect(again.status).toBe(BOOKING_STATUS.CANCELLED);
    expect(provider.calls).toHaveLength(1);
  });

  it('the same key after success returns CONFIRMED without a second charge', async () => {
    const { bookingId, userId } = await heldBooking();
    await service.pay({ bookingId, userId, idempotencyKey: key('4') });

    const again = await service.pay({ bookingId, userId, idempotencyKey: key('4') });

    expect(again.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toHaveLength(1);
    expect(await outboxRowsOf(bookingId)).toHaveLength(1);
  });

  it('another key on a confirmed booking is a conflict', async () => {
    const { bookingId, userId } = await heldBooking();
    await service.pay({ bookingId, userId, idempotencyKey: key('5') });

    await expect(
      service.pay({ bookingId, userId, idempotencyKey: key('6') })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(provider.calls).toHaveLength(1);
  });

  it('a hold past its expiry is a conflict and is not charged', async () => {
    const { bookingId, userId } = await heldBooking();
    now = new Date(NOW.getTime() + (env.HOLD_TTL_SECONDS + 1) * 1000);

    await expect(
      service.pay({ bookingId, userId, idempotencyKey: key('7') })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(provider.calls).toHaveLength(0);
  });

  it("another user's booking is forbidden, an unknown one not found", async () => {
    const { bookingId } = await heldBooking();

    await expect(
      service.pay({ bookingId, userId: randomUUID(), idempotencyKey: key('8') })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.cancel({ bookingId, userId: randomUUID() })).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(
      service.pay({ bookingId: randomUUID(), userId: randomUUID(), idempotencyKey: key('9') })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(provider.calls).toHaveLength(0);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row?.status).toBe(BOOKING_STATUS.HELD);
  });

  it('cancel of a confirmed booking frees the seat', async () => {
    const { bookingId, userId, eventId, seatId } = await heldBooking();
    await service.pay({ bookingId, userId, idempotencyKey: key('10') });

    const view = await service.cancel({ bookingId, userId });
    const next = await service.hold({ eventId, seatId, userId: randomUUID() });

    expect(view.status).toBe(BOOKING_STATUS.CANCELLED);
    expect(next.outcome).toBe(HOLD_OUTCOME.PLACED);
  });

  it('cancel of a booking that cannot be cancelled is a conflict', async () => {
    const { bookingId, userId } = await heldBooking();
    await service.cancel({ bookingId, userId });

    await expect(service.cancel({ bookingId, userId })).rejects.toBeInstanceOf(ConflictException);
  });
});
