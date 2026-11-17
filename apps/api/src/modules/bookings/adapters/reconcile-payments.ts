import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  BOOKING_STATUS,
  PAYMENT_ATTEMPT_STATUS,
  type PaymentAttemptStatus,
} from '@app/shared';
import type { Logger } from '@nestjs/common';
import { and, eq, inArray, lte, or } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { bookings, paymentAttempts } from '../../../infrastructure/database/schema.js';
import { RECONCILE_STALE_SECONDS, refundKey } from '../domain/payment-provider.js';
import { confirmPaidBooking } from './apply-payment.js';
import type { BookingPorts } from './booking-ports.js';
import { paymentApplied } from './booking-transitions.js';
import { setPaymentAttemptStatus } from './payment-attempts.js';

const BATCH_SIZE = 50;
const CHARGED_AGE_SECONDS = 5;
const SECOND_MS = 1000;

interface AttemptRow {
  idempotencyKey: string;
  bookingId: string;
  userId: string;
  amountCents: number;
  status: PaymentAttemptStatus;
  requestId: string;
  claimedAt: Date;
}

export interface ReconcileResult {
  settled: {
    bookingId: string;
    status: typeof BOOKING_STATUS.CONFIRMED;
    eventId: string;
    seatId: string;
  }[];
  refunded: number;
  released: number;
}

export interface ReconcileDeps {
  db: Database;
  ports: Pick<BookingPorts, 'payments' | 'audit' | 'outbox'>;
  logger: Logger;
}

/**
 * Settles payment attempts stranded by a process crash or a failed late-charge refund:
 * - `REFUND_PENDING`: retries `payments.refund` and audits `PAYMENT_REFUNDED`;
 * - `CHARGED`: applies `CONFIRMED` if the booking is still `HELD`, otherwise moves to `REFUND_PENDING`
 *   and refunds;
 * - stale `CLAIMED`: probes `payments.lookup` (if supported) to promote to `CHARGED` or release.
 */
export async function reconcilePaymentAttempts(
  deps: ReconcileDeps,
  now: Date
): Promise<ReconcileResult> {
  const result: ReconcileResult = { settled: [], refunded: 0, released: 0 };
  const rows = await selectDueAttempts(deps.db, now);
  for (const row of rows) {
    try {
      await reconcileOne(deps, row, now, result);
    } catch (error) {
      deps.logger.warn(
        `payment reconciliation deferred for booking ${row.bookingId}: ${error instanceof Error ? error.name : 'Error'}`
      );
    }
  }
  return result;
}

async function selectDueAttempts(db: Database, now: Date): Promise<AttemptRow[]> {
  const chargedCutoff = new Date(now.getTime() - CHARGED_AGE_SECONDS * SECOND_MS);
  const claimedCutoff = new Date(now.getTime() - RECONCILE_STALE_SECONDS * SECOND_MS);
  return db
    .select({
      idempotencyKey: paymentAttempts.idempotencyKey,
      bookingId: paymentAttempts.bookingId,
      userId: paymentAttempts.userId,
      amountCents: paymentAttempts.amountCents,
      status: paymentAttempts.status,
      requestId: paymentAttempts.requestId,
      claimedAt: paymentAttempts.claimedAt,
    })
    .from(paymentAttempts)
    .where(
      or(
        and(
          eq(paymentAttempts.status, PAYMENT_ATTEMPT_STATUS.REFUND_PENDING),
          lte(paymentAttempts.updatedAt, now)
        ),
        and(
          eq(paymentAttempts.status, PAYMENT_ATTEMPT_STATUS.CHARGED),
          lte(paymentAttempts.updatedAt, chargedCutoff)
        ),
        and(
          eq(paymentAttempts.status, PAYMENT_ATTEMPT_STATUS.CLAIMED),
          lte(paymentAttempts.updatedAt, claimedCutoff)
        )
      )
    )
    .limit(BATCH_SIZE);
}

async function reconcileOne(
  deps: ReconcileDeps,
  row: AttemptRow,
  now: Date,
  result: ReconcileResult
): Promise<void> {
  if (row.status === PAYMENT_ATTEMPT_STATUS.REFUND_PENDING) {
    if (await refundAndAudit(deps, row, now)) result.refunded += 1;
    return;
  }
  if (row.status === PAYMENT_ATTEMPT_STATUS.CLAIMED) {
    const outcome = await probeClaimed(deps, row, now);
    if (outcome === 'released') result.released += 1;
    if (outcome !== 'charged') return;
  }
  const applied = await applyChargedRow(deps, row, now);
  if (applied.confirmed !== undefined) result.settled.push(applied.confirmed);
  if (applied.needsRefund && (await refundAndAudit(deps, row, now))) result.refunded += 1;
}

async function probeClaimed(
  deps: ReconcileDeps,
  row: AttemptRow,
  now: Date
): Promise<'charged' | 'released' | 'skip'> {
  if (deps.ports.payments.lookup === undefined) {
    return (await releaseIfNotHeld(deps.db, row, now)) ? 'released' : 'skip';
  }
  const looked = await deps.ports.payments.lookup(row.idempotencyKey);
  if (looked === null) return 'skip';
  if (looked.charged) {
    const promoted = await setPaymentAttemptStatus(deps.db, row.idempotencyKey, {
      from: [PAYMENT_ATTEMPT_STATUS.CLAIMED],
      to: PAYMENT_ATTEMPT_STATUS.CHARGED,
      at: now,
    });
    return promoted ? 'charged' : 'skip';
  }
  return (await releaseClaimed(deps.db, row, now)) ? 'released' : 'skip';
}

async function releaseIfNotHeld(db: Database, row: AttemptRow, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [booking] = await tx
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, row.bookingId))
      .for('update');
    if (booking !== undefined && booking.status === BOOKING_STATUS.HELD) return false;
    return setPaymentAttemptStatus(tx, row.idempotencyKey, {
      from: [PAYMENT_ATTEMPT_STATUS.CLAIMED],
      to: PAYMENT_ATTEMPT_STATUS.RELEASED,
      at: now,
    });
  });
}

async function releaseClaimed(db: Database, row: AttemptRow, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [booking] = await tx
      .select({ status: bookings.status, key: bookings.paymentIdempotencyKey })
      .from(bookings)
      .where(eq(bookings.id, row.bookingId))
      .for('update');
    if (booking?.status === BOOKING_STATUS.HELD && booking.key === row.idempotencyKey) {
      await tx
        .update(bookings)
        .set({ paymentIdempotencyKey: null, paymentClaimedAt: null })
        .where(eq(bookings.id, row.bookingId));
    }
    return setPaymentAttemptStatus(tx, row.idempotencyKey, {
      from: [PAYMENT_ATTEMPT_STATUS.CLAIMED],
      to: PAYMENT_ATTEMPT_STATUS.RELEASED,
      at: now,
    });
  });
}

async function applyChargedRow(
  deps: ReconcileDeps,
  row: AttemptRow,
  now: Date
): Promise<{
  confirmed?: ReconcileResult['settled'][number];
  needsRefund: boolean;
}> {
  return deps.db.transaction(async (tx) => {
    const [attempt] = await tx
      .select({ status: paymentAttempts.status })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.idempotencyKey, row.idempotencyKey),
          eq(paymentAttempts.status, PAYMENT_ATTEMPT_STATUS.CHARGED)
        )
      )
      .for('update', { skipLocked: true });
    if (attempt === undefined) return { needsRefund: false };

    const [booking] = await tx
      .select({
        id: bookings.id,
        eventId: bookings.eventId,
        seatId: bookings.seatId,
        status: bookings.status,
        holdExpiresAt: bookings.holdExpiresAt,
      })
      .from(bookings)
      .where(eq(bookings.id, row.bookingId))
      .for('update');
    if (booking === undefined) return { needsRefund: false };
    if (booking.status !== BOOKING_STATUS.HELD) {
      return resolveNonHeldChargedRow(tx, row, booking.id, now);
    }
    await confirmPaidBooking(tx, deps.ports, {
      booking,
      userId: row.userId,
      idempotencyKey: row.idempotencyKey,
      requestId: row.requestId,
      eventId: booking.eventId,
      at: row.claimedAt,
    });
    return {
      confirmed: {
        bookingId: booking.id,
        status: BOOKING_STATUS.CONFIRMED,
        eventId: booking.eventId,
        seatId: booking.seatId,
      },
      needsRefund: false,
    };
  });
}

async function resolveNonHeldChargedRow(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  row: AttemptRow,
  bookingId: string,
  now: Date
): Promise<{ needsRefund: boolean }> {
  const alreadyApplied = await paymentApplied(tx, bookingId);
  await setPaymentAttemptStatus(tx, row.idempotencyKey, {
    from: [PAYMENT_ATTEMPT_STATUS.CHARGED],
    to: alreadyApplied ? PAYMENT_ATTEMPT_STATUS.APPLIED : PAYMENT_ATTEMPT_STATUS.REFUND_PENDING,
    at: now,
  });
  return { needsRefund: !alreadyApplied };
}

async function refundAndAudit(deps: ReconcileDeps, row: AttemptRow, now: Date): Promise<boolean> {
  await deps.ports.payments.refund({
    bookingId: row.bookingId,
    amountCents: row.amountCents,
    idempotencyKey: refundKey(row.idempotencyKey),
  });
  return deps.db.transaction(async (tx) => {
    const [attempt] = await tx
      .select({ status: paymentAttempts.status })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.idempotencyKey, row.idempotencyKey),
          inArray(paymentAttempts.status, [
            PAYMENT_ATTEMPT_STATUS.REFUND_PENDING,
            PAYMENT_ATTEMPT_STATUS.CHARGED,
          ])
        )
      )
      .for('update', { skipLocked: true });
    if (attempt === undefined) return false;
    await setPaymentAttemptStatus(tx, row.idempotencyKey, {
      from: [PAYMENT_ATTEMPT_STATUS.REFUND_PENDING, PAYMENT_ATTEMPT_STATUS.CHARGED],
      to: PAYMENT_ATTEMPT_STATUS.REFUNDED,
      at: now,
    });
    await deps.ports.audit.record(tx, {
      actorId: row.userId,
      action: AUDIT_ACTION.PAYMENT_REFUNDED,
      subjectType: AUDIT_SUBJECT.BOOKING,
      subjectId: row.bookingId,
      requestId: row.requestId,
    });
    return true;
  });
}
