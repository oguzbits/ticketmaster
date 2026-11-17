import { AUDIT_ACTION, AUDIT_SUBJECT, type BookingStatus } from '@app/shared';
import { ConflictException } from '@nestjs/common';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { refundKey } from '../domain/payment-provider.js';
import type { BookingPorts } from './booking-ports.js';

/**
 * A charge that succeeded after its booking left HELD (the expiry job took it while the provider
 * answered): the money goes back under a key derived from the charge key, outside any transaction,
 * the refund is audited and the payment answers 409. A refund that throws is not audited and
 * reaches the caller.
 * shortcut: a retry cannot repeat a failed refund (the claim refuses a booking that left HELD), so
 * it needs a manual refund until a reconciliation job exists.
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
  },
  status: BookingStatus
): Promise<never> {
  await payments.refund({
    bookingId: pay.bookingId,
    amountCents: pay.amountCents,
    idempotencyKey: refundKey(pay.idempotencyKey),
  });
  await db.transaction((tx) =>
    audit.record(tx, {
      actorId: pay.userId,
      action: AUDIT_ACTION.PAYMENT_REFUNDED,
      subjectType: AUDIT_SUBJECT.BOOKING,
      subjectId: pay.bookingId,
      requestId: pay.requestId,
    })
  );
  throw new ConflictException(`Booking is ${status}, the payment was refunded`);
}
