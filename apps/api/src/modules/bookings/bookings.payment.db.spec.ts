import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  OUTBOX_MESSAGE_TYPE,
  type QueueMessage,
  QueueMessageSchema,
  TRANSITION_REASON,
} from '@app/shared';
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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
import { auditRowsOfSubject } from '../audit/testing/index.js';
import { OutboxService } from '../outbox/index.js';
import { FakeMessageQueue } from '../outbox/testing/index.js';
import type { BookingsService } from './bookings.service.js';
import type { BookingState } from './domain/booking-state-machine.js';
import {
  PAYMENT_GRACE_SECONDS,
  PaymentNotChargedError,
  type PaymentProvider,
} from './domain/payment-provider.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';
import { RecordingMetrics } from './testing/recording-metrics.js';

const NOW = SPEC_NOW;
const SEAT_PRICE_CENTS = 1000;
const PARALLEL_CHARGE_MS = 200;
// The key column is unique over the whole table, so every run needs fresh keys.
const RUN_ID = randomUUID();
const key = (name: string): string => `${RUN_ID}-${name}`;

class RecordingProvider implements PaymentProvider {
  readonly calls: Parameters<PaymentProvider['charge']>[0][] = [];
  readonly refunds: Parameters<PaymentProvider['refund']>[0][] = [];
  /** The next refund throws instead of returning money. */
  failRefundNext = false;
  succeed = true;
  chargeDelayMs = 0;
  /** Runs inside the charge, while the provider is "talking to the network". */
  duringCharge: (input: Parameters<PaymentProvider['charge']>[0]) => Promise<void> = async () => {};
  /** The next charge throws instead of answering (the provider is down, the process dies). */
  failNext = false;
  /** The next charge throws the error of a provider that answered it did not charge. */
  declineNext = false;
  async charge(input: Parameters<PaymentProvider['charge']>[0]): Promise<{ succeeded: boolean }> {
    this.calls.push(input);
    await this.duringCharge(input);
    await delay(this.chargeDelayMs);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('provider down');
    }
    if (this.declineNext) {
      this.declineNext = false;
      throw new PaymentNotChargedError('provider refused the request');
    }
    return { succeeded: this.succeed };
  }

  async refund(input: Parameters<PaymentProvider['refund']>[0]): Promise<void> {
    if (this.failRefundNext) {
      this.failRefundNext = false;
      throw new Error('refund failed');
    }
    this.refunds.push(input);
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
  const metrics = new RecordingMetrics();

  beforeAll(async () => {
    redis = await openTestRedis();
    const clock = { now: () => now };
    outbox = new CrashingOutbox(db, clock, new FakeMessageQueue());
    service = createBookingsService(db, redis, clock, provider, undefined, outbox, metrics);
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
    provider.declineNext = false;
    provider.failRefundNext = false;
    provider.refunds.length = 0;
    outbox.crashNext = false;
    provider.duringCharge = async () => {};
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');
    const userId = randomUUID();
    const result = await service.hold({ eventId, seatId, userId, requestId: null });
    if (result.outcome !== HOLD_OUTCOME.PLACED) throw new Error('hold was not placed');
    return { bookingId: result.bookingId, userId, eventId, seatId };
  }

  /** The actions audited for the booking, in order. */
  const auditedActions = async (bookingId: string): Promise<string[]> =>
    (await auditRowsOfSubject(db, bookingId)).map((row) => row.action);

  async function transitionsOf(bookingId: string): Promise<string[]> {
    const rows = await db
      .select()
      .from(bookingTransitions)
      .where(eq(bookingTransitions.bookingId, bookingId));
    return rows.map((row) => `${row.fromStatus}>${row.toStatus}`).sort();
  }

  it('pays a held booking and confirms it with HELD→PAID→CONFIRMED transitions', async () => {
    const { bookingId, userId } = await heldBooking();

    const view = await service.pay({
      bookingId,
      userId,
      idempotencyKey: key('1'),
      requestId: 'spec',
    });

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

  it('a confirmed payment writes one BOOKING_PAID audit row with the payer and the request ID, a failed one writes none', async () => {
    const paid = await heldBooking();
    await service.pay({ ...paid, idempotencyKey: key('audit-ok'), requestId: 'req-pay-1' });
    const failed = await heldBooking();
    provider.succeed = false;
    await service.pay({ ...failed, idempotencyKey: key('audit-fail'), requestId: 'req-pay-2' });

    expect(await auditRowsOfSubject(db, paid.bookingId)).toMatchObject([
      {
        actorId: paid.userId,
        action: AUDIT_ACTION.BOOKING_PAID,
        subjectType: AUDIT_SUBJECT.BOOKING,
        subjectId: paid.bookingId,
        requestId: 'req-pay-1',
      },
    ]);
    expect(await auditedActions(failed.bookingId)).toEqual([]);
  });

  it('a confirmed payment writes one outbox row with IDs only, a failed one writes none', async () => {
    const paid = await heldBooking();
    await service.pay({ ...paid, idempotencyKey: key('row-ok'), requestId: 'spec' });
    const failed = await heldBooking();
    provider.succeed = false;
    await service.pay({ ...failed, idempotencyKey: key('row-fail'), requestId: 'spec' });

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

    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
    ).rejects.toThrow('apply crashed');
    const afterCrash = {
      status: (await rowOf(bookingId)).status,
      transitions: await transitionsOf(bookingId),
      rows: await outboxRowsOf(bookingId),
      audited: await auditedActions(bookingId),
    };
    const retried = await service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' });

    expect(afterCrash).toEqual({
      status: BOOKING_STATUS.HELD,
      transitions: [`null>${BOOKING_STATUS.HELD}`],
      rows: [],
      audited: [],
    });
    expect(retried.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toHaveLength(2);
    expect(await outboxRowsOf(bookingId)).toHaveLength(1);
    expect(await auditedActions(bookingId)).toEqual([AUDIT_ACTION.BOOKING_PAID]);
  });

  it('a failed charge cancels with PAYMENT_FAILED', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.succeed = false;

    const view = await service.pay({
      bookingId,
      userId,
      idempotencyKey: key('2'),
      requestId: 'spec',
    });

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
    await service.pay({ ...first, idempotencyKey: key('shared'), requestId: 'spec' });
    const second = await heldBooking();

    await expect(
      service.pay({ ...second, idempotencyKey: key('shared'), requestId: 'spec' })
    ).rejects.toBeInstanceOf(ConflictException);
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

    await service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' });

    expect(seen).toEqual([{ claimedKey: idempotencyKey, lockError: null }]);
  });

  it('a charge that throws leaves the key claimed; the retry with the same key charges again and confirms', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('crash-charge');
    provider.failNext = true;

    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
    ).rejects.toThrow('provider down');
    const afterCrash = await rowOf(bookingId);
    const retried = await service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' });

    expect(afterCrash).toMatchObject({
      status: BOOKING_STATUS.HELD,
      paymentIdempotencyKey: idempotencyKey,
    });
    expect(retried.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toHaveLength(2);
    expect(await transitionsOf(bookingId)).toHaveLength(3);
  });

  it('a provider that did not charge releases the claim; the retry with the same key charges and confirms', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('not-charged');
    provider.declineNext = true;

    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
    ).rejects.toBeInstanceOf(BadGatewayException);
    const afterRelease = await rowOf(bookingId);
    const retried = await service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' });

    expect(afterRelease).toMatchObject({
      status: BOOKING_STATUS.HELD,
      paymentIdempotencyKey: null,
      paymentClaimedAt: null,
    });
    expect(retried.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toHaveLength(2);
  });

  it('after a release the customer can pay with another key or cancel', async () => {
    const paying = await heldBooking();
    provider.declineNext = true;
    await expect(
      service.pay({ ...paying, idempotencyKey: key('released-a'), requestId: 'spec' })
    ).rejects.toBeInstanceOf(BadGatewayException);
    const cancelling = await heldBooking();
    provider.declineNext = true;
    await expect(
      service.pay({ ...cancelling, idempotencyKey: key('released-b'), requestId: 'spec' })
    ).rejects.toBeInstanceOf(BadGatewayException);

    const paid = await service.pay({
      ...paying,
      idempotencyKey: key('released-c'),
      requestId: 'spec',
    });
    const cancelled = await service.cancel({ ...cancelling, requestId: 'spec' });

    expect(paid.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(cancelled.status).toBe(BOOKING_STATUS.CANCELLED);
  });

  it('a release leaves the key of a payment another instance confirmed meanwhile', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('released-late');
    const other = createBookingsService(
      db,
      redis,
      { now: () => now },
      new RecordingProvider(),
      undefined,
      outbox
    );
    provider.declineNext = true;
    provider.duringCharge = async () => {
      await other.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' });
    };

    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(await rowOf(bookingId)).toMatchObject({
      status: BOOKING_STATUS.CONFIRMED,
      paymentIdempotencyKey: idempotencyKey,
    });
  });

  it('a retry after the hold ran out but inside the grace confirms once, dated at the claim', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('grace-retry');
    provider.failNext = true;
    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
    ).rejects.toThrow('provider down');
    now = new Date(NOW.getTime() + (env.HOLD_TTL_SECONDS + 1) * 1000);

    const retried = await service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' });
    const again = await service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' });

    expect(retried.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(again.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toHaveLength(2);
    const [row, ...more] = await outboxRowsOf(bookingId);
    expect(more).toEqual([]);
    expect(row?.payload).toMatchObject({ occurredAt: NOW.toISOString() });
    const stored = await rowOf(bookingId);
    expect(stored.updatedAt).toEqual(NOW);
    expect(stored.paymentClaimedAt).toEqual(NOW);
  });

  it('a second retry keeps the time of the first claim', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('claim-time');
    provider.failNext = true;
    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
    ).rejects.toThrow('provider down');
    now = new Date(NOW.getTime() + 5000);
    provider.failNext = true;
    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
    ).rejects.toThrow('provider down');

    expect((await rowOf(bookingId)).paymentClaimedAt).toEqual(NOW);
  });

  it('a claimed key without a claim time (claimed before the column existed) plans at the time of the retry', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('legacy-claim');
    await db
      .update(bookings)
      .set({ paymentIdempotencyKey: idempotencyKey, paymentClaimedAt: null })
      .where(eq(bookings.id, bookingId));
    now = new Date(NOW.getTime() + 5000);

    const view = await service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' });

    expect(view.status).toBe(BOOKING_STATUS.CONFIRMED);
    const [row] = await outboxRowsOf(bookingId);
    expect(row?.payload).toMatchObject({ occurredAt: now.toISOString() });
  });

  it('ten parallel payments with one key charge once and all answer CONFIRMED', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('ten');
    provider.chargeDelayMs = PARALLEL_CHARGE_MS;

    const views = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
      )
    );

    expect(new Set(views.map((view) => view.status))).toEqual(new Set([BOOKING_STATUS.CONFIRMED]));
    expect(provider.calls).toHaveLength(1);
    expect(await transitionsOf(bookingId)).toHaveLength(3);
    expect(await outboxRowsOf(bookingId)).toHaveLength(1);
    expect(await auditedActions(bookingId)).toEqual([AUDIT_ACTION.BOOKING_PAID]);
  });

  it('two instances paying with one key at once apply the result once and answer alike', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('instances');
    provider.chargeDelayMs = PARALLEL_CHARGE_MS;
    const other = createBookingsService(db, redis, { now: () => now }, provider, undefined, outbox);

    const views = await Promise.all([
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' }),
      other.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' }),
    ]);

    // Each instance may call the provider; a real one answers a repeated key with the first result.
    expect(views.map((view) => view.status)).toEqual([
      BOOKING_STATUS.CONFIRMED,
      BOOKING_STATUS.CONFIRMED,
    ]);
    expect(await transitionsOf(bookingId)).toHaveLength(3);
    expect(await outboxRowsOf(bookingId)).toHaveLength(1);
    expect(await auditedActions(bookingId)).toEqual([AUDIT_ACTION.BOOKING_PAID]);
  });

  it('ten parallel payments with different keys on one booking: one wins, the others conflict', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.chargeDelayMs = PARALLEL_CHARGE_MS;

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        service.pay({ bookingId, userId, idempotencyKey: key(`many-${i}`), requestId: 'spec' })
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

  it('a cancel while a payment is claimed is a conflict: the charge may be in flight, the payment still confirms', async () => {
    const { bookingId, userId } = await heldBooking();
    const cancels: PromiseSettledResult<BookingState>[] = [];
    provider.duringCharge = async () => {
      cancels.push(
        ...(await Promise.allSettled([service.cancel({ bookingId, userId, requestId: 'spec' })]))
      );
    };

    const view = await service.pay({
      bookingId,
      userId,
      idempotencyKey: key('cancel-during'),
      requestId: 'spec',
    });

    expect(cancels.map((c) => c.status === 'rejected' && c.reason)).toEqual([
      expect.any(ConflictException),
    ]);
    expect(view.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(await transitionsOf(bookingId)).toHaveLength(3);
  });

  it('a cancel after a payment that died after its claim is a conflict; a hold without a claim cancels', async () => {
    const claimed = await heldBooking();
    provider.failNext = true;
    await expect(
      service.pay({ ...claimed, idempotencyKey: key('cancel-claimed'), requestId: 'spec' })
    ).rejects.toThrow('provider down');
    const unclaimed = await heldBooking();

    await expect(service.cancel({ ...claimed, requestId: 'spec' })).rejects.toBeInstanceOf(
      ConflictException
    );
    const view = await service.cancel({ ...unclaimed, requestId: 'spec' });

    expect((await rowOf(claimed.bookingId)).status).toBe(BOOKING_STATUS.HELD);
    expect(view.status).toBe(BOOKING_STATUS.CANCELLED);
  });

  it('the same key after a failed charge returns CANCELLED and does not charge again', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.succeed = false;
    await service.pay({ bookingId, userId, idempotencyKey: key('3'), requestId: 'spec' });
    provider.succeed = true;

    const again = await service.pay({
      bookingId,
      userId,
      idempotencyKey: key('3'),
      requestId: 'spec',
    });

    expect(again.status).toBe(BOOKING_STATUS.CANCELLED);
    expect(provider.calls).toHaveLength(1);
  });

  it('the same key after success returns CONFIRMED without a second charge', async () => {
    const { bookingId, userId } = await heldBooking();
    await service.pay({ bookingId, userId, idempotencyKey: key('4'), requestId: 'spec' });

    const again = await service.pay({
      bookingId,
      userId,
      idempotencyKey: key('4'),
      requestId: 'spec',
    });

    expect(again.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(provider.calls).toHaveLength(1);
    expect(await outboxRowsOf(bookingId)).toHaveLength(1);
  });

  it('another key on a confirmed booking is a conflict', async () => {
    const { bookingId, userId } = await heldBooking();
    await service.pay({ bookingId, userId, idempotencyKey: key('5'), requestId: 'spec' });

    await expect(
      service.pay({ bookingId, userId, idempotencyKey: key('6'), requestId: 'spec' })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(provider.calls).toHaveLength(1);
  });

  /** The hold ran out and the expiry job took the booking while the provider was charging. */
  const expireDuringCharge = (): void => {
    provider.duringCharge = async () => {
      now = new Date(NOW.getTime() + (env.HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS + 1) * 1000);
      expect(await service.expireHolds(now)).toBeGreaterThan(0);
    };
  };

  it('a charge that succeeds after the booking expired is refunded once under a derived key and audited', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('late-charge');
    expireDuringCharge();

    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'req-late' })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(provider.refunds).toEqual([
      { bookingId, amountCents: SEAT_PRICE_CENTS, idempotencyKey: `refund:${idempotencyKey}` },
    ]);
    expect((await rowOf(bookingId)).status).toBe(BOOKING_STATUS.EXPIRED);
    expect(await auditRowsOfSubject(db, bookingId)).toMatchObject([
      {
        actorId: userId,
        action: AUDIT_ACTION.PAYMENT_REFUNDED,
        subjectId: bookingId,
        requestId: 'req-late',
      },
    ]);
  });

  it('a charge that did not succeed after the booking expired is not refunded', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.succeed = false;
    expireDuringCharge();

    await expect(
      service.pay({ bookingId, userId, idempotencyKey: key('late-declined'), requestId: 'spec' })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(provider.refunds).toEqual([]);
    expect(await auditedActions(bookingId)).toEqual([]);
  });

  it('a refund that fails is not audited and the error reaches the caller', async () => {
    const { bookingId, userId } = await heldBooking();
    provider.failRefundNext = true;
    expireDuringCharge();

    await expect(
      service.pay({
        bookingId,
        userId,
        idempotencyKey: key('late-refund-fails'),
        requestId: 'spec',
      })
    ).rejects.toThrow('refund failed');

    expect(await auditedActions(bookingId)).toEqual([]);
  });

  it('a hold past its expiry is a conflict and is not charged', async () => {
    const { bookingId, userId } = await heldBooking();
    now = new Date(NOW.getTime() + (env.HOLD_TTL_SECONDS + 1) * 1000);

    await expect(
      service.pay({ bookingId, userId, idempotencyKey: key('7'), requestId: 'spec' })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(provider.calls).toHaveLength(0);
  });

  it("another user's booking is forbidden, an unknown one not found", async () => {
    const { bookingId } = await heldBooking();

    await expect(
      service.pay({ bookingId, userId: randomUUID(), idempotencyKey: key('8'), requestId: 'spec' })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.cancel({ bookingId, userId: randomUUID(), requestId: 'spec' })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.pay({
        bookingId: randomUUID(),
        userId: randomUUID(),
        idempotencyKey: key('9'),
        requestId: 'spec',
      })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(provider.calls).toHaveLength(0);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row?.status).toBe(BOOKING_STATUS.HELD);
  });

  it('cancel of a confirmed booking frees the seat', async () => {
    const { bookingId, userId, eventId, seatId } = await heldBooking();
    await service.pay({ bookingId, userId, idempotencyKey: key('10'), requestId: 'spec' });

    const view = await service.cancel({ bookingId, userId, requestId: 'spec' });
    const next = await service.hold({ eventId, seatId, userId: randomUUID(), requestId: null });

    expect(view.status).toBe(BOOKING_STATUS.CANCELLED);
    expect(next.outcome).toBe(HOLD_OUTCOME.PLACED);
  });

  it('a cancel writes one BOOKING_CANCELLED audit row with the user and the request ID', async () => {
    const { bookingId, userId } = await heldBooking();

    await service.cancel({ bookingId, userId, requestId: 'req-cancel-1' });

    expect(await auditRowsOfSubject(db, bookingId)).toMatchObject([
      {
        actorId: userId,
        action: AUDIT_ACTION.BOOKING_CANCELLED,
        subjectType: AUDIT_SUBJECT.BOOKING,
        subjectId: bookingId,
        requestId: 'req-cancel-1',
      },
    ]);
  });

  it('a cancel the state machine or a claimed payment refuses writes no audit row', async () => {
    const cancelled = await heldBooking();
    await service.cancel({ ...cancelled, requestId: 'req-cancel-2' });
    const claimed = await heldBooking();
    provider.failNext = true;
    await service
      .pay({ ...claimed, idempotencyKey: key('audit-claimed'), requestId: 'spec' })
      .catch(() => undefined);

    await expect(
      service.cancel({ ...cancelled, requestId: 'req-cancel-3' })
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(service.cancel({ ...claimed, requestId: 'req-cancel-4' })).rejects.toBeInstanceOf(
      ConflictException
    );

    expect(await auditedActions(cancelled.bookingId)).toEqual([AUDIT_ACTION.BOOKING_CANCELLED]);
    expect(await auditedActions(claimed.bookingId)).toEqual([]);
  });

  it('cancel of a booking that cannot be cancelled is a conflict', async () => {
    const { bookingId, userId } = await heldBooking();
    await service.cancel({ bookingId, userId, requestId: 'spec' });

    await expect(service.cancel({ bookingId, userId, requestId: 'spec' })).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  describe('metrics', () => {
    const settled = (status: string) => ({ method: 'bookingSettled', args: [status] });
    /** What the metrics port was told while `action` ran. */
    async function recordedDuring<T>(action: () => Promise<T>) {
      const before = metrics.calls.length;
      await action();
      return metrics.calls.slice(before);
    }

    it('a confirmed payment counts CONFIRMED once; the same key again counts nothing', async () => {
      const { bookingId, userId } = await heldBooking();
      const idempotencyKey = key('metrics-ok');

      const first = await recordedDuring(() =>
        service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
      );
      const again = await recordedDuring(() =>
        service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
      );

      expect(first).toEqual([settled(BOOKING_STATUS.CONFIRMED)]);
      expect(again).toEqual([]);
    });

    it('ten parallel payments with one key count once', async () => {
      const { bookingId, userId } = await heldBooking();
      const idempotencyKey = key('metrics-ten');
      provider.chargeDelayMs = PARALLEL_CHARGE_MS;

      const recorded = await recordedDuring(() =>
        Promise.all(
          Array.from({ length: 10 }, () =>
            service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
          )
        )
      );

      expect(recorded).toEqual([settled(BOOKING_STATUS.CONFIRMED)]);
    });

    it('two instances paying with one key at once count once: the one that lost the apply counts nothing', async () => {
      const { bookingId, userId } = await heldBooking();
      const idempotencyKey = key('metrics-instances');
      provider.chargeDelayMs = PARALLEL_CHARGE_MS;
      const other = createBookingsService(
        db,
        redis,
        { now: () => now },
        provider,
        undefined,
        outbox,
        metrics
      );

      const recorded = await recordedDuring(() =>
        Promise.all([
          service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' }),
          other.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' }),
        ])
      );

      expect(recorded).toEqual([settled(BOOKING_STATUS.CONFIRMED)]);
    });

    it('a failed charge counts the resulting CANCELLED once', async () => {
      const { bookingId, userId } = await heldBooking();
      provider.succeed = false;

      const recorded = await recordedDuring(() =>
        service.pay({ bookingId, userId, idempotencyKey: key('metrics-fail'), requestId: 'spec' })
      );

      expect(recorded).toEqual([settled(BOOKING_STATUS.CANCELLED)]);
    });

    it('an apply step that rolls back counts nothing; the retry counts once', async () => {
      const { bookingId, userId } = await heldBooking();
      const idempotencyKey = key('metrics-crash');
      outbox.crashNext = true;

      const crashed = await recordedDuring(() =>
        expect(
          service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
        ).rejects.toThrow('apply crashed')
      );
      const retried = await recordedDuring(() =>
        service.pay({ bookingId, userId, idempotencyKey, requestId: 'spec' })
      );

      expect(crashed).toEqual([]);
      expect(retried).toEqual([settled(BOOKING_STATUS.CONFIRMED)]);
    });

    it('a payment that finds the booking changed under it answers 409 and counts nothing', async () => {
      const { bookingId, userId } = await heldBooking();
      provider.duringCharge = async () => {
        await db
          .update(bookings)
          .set({ status: BOOKING_STATUS.EXPIRED })
          .where(eq(bookings.id, bookingId));
      };

      const recorded = await recordedDuring(() =>
        expect(
          service.pay({
            bookingId,
            userId,
            idempotencyKey: key('metrics-conflict'),
            requestId: 'spec',
          })
        ).rejects.toBeInstanceOf(ConflictException)
      );

      expect(recorded).toEqual([]);
    });

    it('a cancel counts CANCELLED once; a refused cancel counts nothing', async () => {
      const { bookingId, userId } = await heldBooking();

      const cancelled = await recordedDuring(() =>
        service.cancel({ bookingId, userId, requestId: 'spec' })
      );
      const refused = await recordedDuring(() =>
        expect(service.cancel({ bookingId, userId, requestId: 'spec' })).rejects.toBeInstanceOf(
          ConflictException
        )
      );

      expect(cancelled).toEqual([settled(BOOKING_STATUS.CANCELLED)]);
      expect(refused).toEqual([]);
    });
  });
});
