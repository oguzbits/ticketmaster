import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  type BookingStatus,
  PAYMENT_ATTEMPT_STATUS,
} from '@app/shared';
import { ConflictException } from '@nestjs/common';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { refundKey } from '../domain/payment-provider.js';
import type { BookingPorts } from './booking-ports.js';
import { setPaymentAttemptStatus } from './payment-attempts.js';

/**
 * A charge that succeeded after its booking left HELD (the expiry job took it while the provider
 * answered): the money goes back under a key derived from the charge key, outside any transaction,
 * the refund is audited, the payment attempt is marked REFUNDED, and the payment answers 409.
 * If the refund throws, the attempt remains `REFUND_PENDING` so the worker reconciliation job retries it.
 */
export async function refundLateCharge(
  db: Database,
  { payments, audit }: Pick<BookingPorts, 'payments' | 'audit'>,
  pay: {
    bookingId: string;
    userId: string;
    idempotencyKey: string;
    requestId: string;
    amountCents: number;
    at: Date;
  },
  status: BookingStatus
): Promise<never> {
  await payments.refund({
    bookingId: pay.bookingId,
    amountCents: pay.amountCents,
    idempotencyKey: refundKey(pay.idempotencyKey),
  });
  await db.transaction(async (tx) => {
    await setPaymentAttemptStatus(tx, pay.idempotencyKey, {
      from: [PAYMENT_ATTEMPT_STATUS.REFUND_PENDING, PAYMENT_ATTEMPT_STATUS.CHARGED],
      to: PAYMENT_ATTEMPT_STATUS.REFUNDED,
      at: pay.at,
    });
    await audit.record(tx, {
      actorId: pay.userId,
      action: AUDIT_ACTION.PAYMENT_REFUNDED,
      subjectType: AUDIT_SUBJECT.BOOKING,
      subjectId: pay.bookingId,
      requestId: pay.requestId,
    });
  });
  throw new ConflictException(`Booking is ${status}, the payment was refunded`);
}
