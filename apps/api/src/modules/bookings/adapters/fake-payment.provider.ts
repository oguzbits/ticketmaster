import { createHash } from 'node:crypto';

import type { PaymentProvider } from '../domain/payment-provider.js';

const UINT32_RANGE = 2 ** 32;

/**
 * Simulated charge, no network involved. The answer is a pure function of the idempotency key and
 * the failure rate (the key's hash, as a share of [0, 1), against the rate), so a retry with the
 * same key gets the same answer, as it does at a real provider. Rate 0 never fails, rate 1 always.
 */
export class FakePaymentProvider implements PaymentProvider {
  constructor(private readonly failureRate: number) {}

  async charge(input: Parameters<PaymentProvider['charge']>[0]): Promise<{ succeeded: boolean }> {
    const hash = createHash('sha256').update(input.idempotencyKey).digest();
    return { succeeded: hash.readUInt32BE(0) / UINT32_RANGE >= this.failureRate };
  }
}
