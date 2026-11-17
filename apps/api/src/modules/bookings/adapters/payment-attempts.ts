import { PAYMENT_ATTEMPT_STATUS, type PaymentAttemptStatus } from '@app/shared';
import { and, eq, inArray } from 'drizzle-orm';

import type { Database, Tx } from '../../../infrastructure/database/database.module.js';
import { paymentAttempts } from '../../../infrastructure/database/schema.js';

export interface ClaimAttemptInput {
  idempotencyKey: string;
  bookingId: string;
  userId: string;
  amountCents: number;
  requestId: string;
  claimedAt: Date;
}

/**
 * Records a claimed payment attempt. Allows re-claiming a key whose earlier attempt ended in
 * `RELEASED` (provider declined without charging) while preserving active or settled attempts.
 */
export async function recordPaymentAttemptClaim(tx: Tx, input: ClaimAttemptInput): Promise<void> {
  await tx
    .insert(paymentAttempts)
    .values({
      ...input,
      status: PAYMENT_ATTEMPT_STATUS.CLAIMED,
      updatedAt: input.claimedAt,
    })
    .onConflictDoUpdate({
      target: paymentAttempts.idempotencyKey,
      set: {
        bookingId: input.bookingId,
        userId: input.userId,
        amountCents: input.amountCents,
        status: PAYMENT_ATTEMPT_STATUS.CLAIMED,
        requestId: input.requestId,
        claimedAt: input.claimedAt,
        updatedAt: input.claimedAt,
      },
      setWhere: eq(paymentAttempts.status, PAYMENT_ATTEMPT_STATUS.RELEASED),
    });
}

/** Transitions a payment attempt only from one of `from` statuses; returns true if updated. */
export async function setPaymentAttemptStatus(
  db: Database | Tx,
  idempotencyKey: string,
  transition: { from: readonly PaymentAttemptStatus[]; to: PaymentAttemptStatus; at: Date }
): Promise<boolean> {
  const updated = await db
    .update(paymentAttempts)
    .set({ status: transition.to, updatedAt: transition.at })
    .where(
      and(
        eq(paymentAttempts.idempotencyKey, idempotencyKey),
        inArray(paymentAttempts.status, [...transition.from])
      )
    )
    .returning({ key: paymentAttempts.idempotencyKey });
  return updated.length > 0;
}
