import { randomUUID } from 'node:crypto';

import {
  AUDIT_ACTION,
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  PAYMENT_ATTEMPT_STATUS,
  type QueueMessage,
  TRANSITION_REASON,
} from '@app/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';
import type { Tx } from '../../infrastructure/database/database.module.js';
import { bookings, outboxMessages, paymentAttempts } from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { RECONCILE_SPEC_START } from '../../testing/time.js';
import { auditRowsOfSubject } from '../audit/testing/index.js';
import { OutboxService } from '../outbox/index.js';
import { FakeMessageQueue } from '../outbox/testing/index.js';
import { planTransition, storeTransition } from './adapters/booking-transitions.js';
import type { BookingsService } from './bookings.service.js';
import { SYSTEM_ACTOR_ID } from './domain/booking-state-machine.js';
import {
  PAYMENT_GRACE_SECONDS,
  type PaymentProvider,
  RECONCILE_STALE_SECONDS,
} from './domain/payment-provider.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';
import { RecordingMetrics } from './testing/recording-metrics.js';

const NOW = RECONCILE_SPEC_START;
const SEAT_PRICE_CENTS = 1000;
const AFTER_CHARGED_AGE_MS = 6000;
const AFTER_STALE_CLAIM_MS = (RECONCILE_STALE_SECONDS + 1) * 1000;
const RUN_ID = randomUUID();
const key = (name: string): string => `${RUN_ID}-${name}`;

class ReconcileProvider implements PaymentProvider {
  readonly refunds: Parameters<PaymentProvider['refund']>[0][] = [];
  failRefundNext = false;
  lookupResult: { charged: boolean } | null = null;
  duringCharge: () => Promise<void> = async () => {};

  async charge(): Promise<{ succeeded: boolean }> {
    await this.duringCharge();
    return { succeeded: true };
  }

  async refund(input: Parameters<PaymentProvider['refund']>[0]): Promise<void> {
    if (this.failRefundNext) {
      this.failRefundNext = false;
      throw new Error('refund failed');
    }
    this.refunds.push(input);
  }

  async lookup(): Promise<{ charged: boolean } | null> {
    return this.lookupResult;
  }
}

class CrashAfterSettleOutbox extends OutboxService {
  crashNext = false;
  override async enqueue(tx: Tx, message: QueueMessage): Promise<void> {
    await super.enqueue(tx, message);
    if (this.crashNext) {
      this.crashNext = false;
      throw new Error('apply crashed after charge');
    }
  }
}

describe('payment reconciliation', () => {
  const database = openTestDatabase();
  const { db } = database;
  const env = loadEnv();
  const provider = new ReconcileProvider();
  let now = NOW;
  let redis: Redis;
  let service: BookingsService;
  let outbox: CrashAfterSettleOutbox;
  const metrics = new RecordingMetrics();

  beforeAll(async () => {
    redis = await openTestRedis();
    const clock = { now: () => now };
    outbox = new CrashAfterSettleOutbox(db, clock, new FakeMessageQueue());
    service = createBookingsService(db, redis, clock, provider, undefined, outbox, metrics);
  });

  afterAll(async () => {
    await redis.quit();
    await database.close();
  });

  async function heldBooking() {
    now = NOW;
    provider.refunds.length = 0;
    provider.failRefundNext = false;
    provider.lookupResult = null;
    provider.duringCharge = async () => {};
    outbox.crashNext = false;
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

  async function attemptStatus(idempotencyKey: string) {
    const [row] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.idempotencyKey, idempotencyKey));
    return row?.status;
  }

  it('settles a CHARGED attempt left by a crash into CONFIRMED with one outbox and audit row', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('charged-crash');
    outbox.crashNext = true;

    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'req-rec-1' })
    ).rejects.toThrow('apply crashed after charge');
    expect(await attemptStatus(idempotencyKey)).toBe(PAYMENT_ATTEMPT_STATUS.CHARGED);

    now = new Date(NOW.getTime() + AFTER_CHARGED_AGE_MS);
    const first = await service.reconcilePayments(now);
    const second = await service.reconcilePayments(now);

    expect(first).toEqual({ settled: 1, refunded: 0, released: 0 });
    expect(second).toEqual({ settled: 0, refunded: 0, released: 0 });
    expect(await attemptStatus(idempotencyKey)).toBe(PAYMENT_ATTEMPT_STATUS.APPLIED);

    const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(booking?.status).toBe(BOOKING_STATUS.CONFIRMED);
    const outboxRows = await db
      .select()
      .from(outboxMessages)
      .where(sql`${outboxMessages.payload}->>'bookingId' = ${bookingId}`);
    expect(outboxRows).toHaveLength(1);
    expect(await auditRowsOfSubject(db, bookingId)).toMatchObject([
      { action: AUDIT_ACTION.BOOKING_PAID, requestId: 'req-rec-1' },
    ]);
  });

  it('refunds a CHARGED attempt whose booking expired before apply and audits PAYMENT_REFUNDED', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('charged-expired');
    outbox.crashNext = true;
    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'req-rec-exp' })
    ).rejects.toThrow('apply crashed after charge');

    now = new Date(NOW.getTime() + (env.HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS + 1) * 1000);
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(bookings).where(eq(bookings.id, bookingId));
      if (row === undefined) throw new Error('missing booking');
      await storeTransition(
        tx,
        planTransition(row, TRANSITION_REASON.HOLD_EXPIRED, SYSTEM_ACTOR_ID, now)
      );
    });

    const res = await service.reconcilePayments(now);

    expect(res).toEqual({ settled: 0, refunded: 1, released: 0 });
    expect(await attemptStatus(idempotencyKey)).toBe(PAYMENT_ATTEMPT_STATUS.REFUNDED);
    expect(provider.refunds).toEqual([
      { bookingId, amountCents: SEAT_PRICE_CENTS, idempotencyKey: `refund:${idempotencyKey}` },
    ]);
    expect(await auditRowsOfSubject(db, bookingId)).toMatchObject([
      { action: AUDIT_ACTION.PAYMENT_REFUNDED, requestId: 'req-rec-exp' },
    ]);
  });

  it('retries a REFUND_PENDING attempt after a failed late refund and audits PAYMENT_REFUNDED', async () => {
    const { bookingId, userId } = await heldBooking();
    const idempotencyKey = key('refund-retry');
    provider.failRefundNext = true;
    provider.duringCharge = async () => {
      now = new Date(NOW.getTime() + (env.HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS + 1) * 1000);
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(bookings).where(eq(bookings.id, bookingId));
        if (row === undefined) throw new Error('missing booking');
        await storeTransition(
          tx,
          planTransition(row, TRANSITION_REASON.HOLD_EXPIRED, SYSTEM_ACTOR_ID, now)
        );
      });
    };

    await expect(
      service.pay({ bookingId, userId, idempotencyKey, requestId: 'req-rec-ref' })
    ).rejects.toThrow('refund failed');
    expect(await attemptStatus(idempotencyKey)).toBe(PAYMENT_ATTEMPT_STATUS.REFUND_PENDING);

    const res = await service.reconcilePayments(now);

    expect(res).toEqual({ settled: 0, refunded: 1, released: 0 });
    expect(await attemptStatus(idempotencyKey)).toBe(PAYMENT_ATTEMPT_STATUS.REFUNDED);
    expect(provider.refunds).toHaveLength(1);
    expect(await auditRowsOfSubject(db, bookingId)).toMatchObject([
      { action: AUDIT_ACTION.PAYMENT_REFUNDED, requestId: 'req-rec-ref' },
    ]);
  });

  it('probes stale CLAIMED attempts via lookup: settles charged ones and releases uncharged ones', async () => {
    const charged = await heldBooking();
    const chargedKey = key('stale-charged');
    const released = await heldBooking();
    const releasedKey = key('stale-released');

    // Simulate process death during charge() right after Step 1 committed the CLAIMED rows.
    await db.transaction(async (tx) => {
      for (const [b, k] of [
        [charged, chargedKey],
        [released, releasedKey],
      ] as const) {
        await tx
          .update(bookings)
          .set({ paymentIdempotencyKey: k, paymentClaimedAt: NOW })
          .where(eq(bookings.id, b.bookingId));
        await tx.insert(paymentAttempts).values({
          idempotencyKey: k,
          bookingId: b.bookingId,
          userId: b.userId,
          amountCents: SEAT_PRICE_CENTS,
          status: PAYMENT_ATTEMPT_STATUS.CLAIMED,
          requestId: 'req-stale',
          claimedAt: NOW,
          updatedAt: NOW,
        });
      }
    });

    now = new Date(NOW.getTime() + AFTER_STALE_CLAIM_MS);

    provider.lookupResult = { charged: true };
    // Run only with charged attempt present first by cancelling released? Simpler: test one by one?
    // Wait: both are stale at the same time, so lookupResult applies to both; inspect/update released separately:
    await db
      .update(paymentAttempts)
      .set({ updatedAt: now })
      .where(eq(paymentAttempts.idempotencyKey, releasedKey));

    const settleRes = await service.reconcilePayments(now);
    expect(settleRes).toEqual({ settled: 1, refunded: 0, released: 0 });
    expect(await attemptStatus(chargedKey)).toBe(PAYMENT_ATTEMPT_STATUS.APPLIED);

    now = new Date(now.getTime() + AFTER_STALE_CLAIM_MS);
    provider.lookupResult = { charged: false };
    const releaseRes = await service.reconcilePayments(now);
    expect(releaseRes).toEqual({ settled: 0, refunded: 0, released: 1 });
    expect(await attemptStatus(releasedKey)).toBe(PAYMENT_ATTEMPT_STATUS.RELEASED);

    const [releasedRow] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, released.bookingId));
    expect(releasedRow?.paymentIdempotencyKey).toBeNull();
  });
});
