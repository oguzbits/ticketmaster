import { BadGatewayException } from '@nestjs/common';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { PaymentNotChargedError, type PaymentProvider } from '../domain/payment-provider.js';
import { releasePaymentKey } from './booking-transitions.js';

/**
 * The charge step of a payment. A provider that says it did not charge frees the claim (502, the
 * customer may retry); any other error keeps it, because the charge may have gone through.
 */
export async function chargeOrRelease(
  db: Database,
  payments: PaymentProvider,
  input: Parameters<PaymentProvider['charge']>[0]
): Promise<boolean> {
  try {
    return (await payments.charge(input)).succeeded;
  } catch (error) {
    if (!(error instanceof PaymentNotChargedError)) throw error;
    await releasePaymentKey(db, input.bookingId);
    throw new BadGatewayException('The payment provider did not charge, try again');
  }
}
