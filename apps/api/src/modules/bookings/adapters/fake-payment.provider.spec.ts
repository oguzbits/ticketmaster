import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { FakePaymentProvider } from './fake-payment.provider.js';

const KEYS = 4000;
const RATE = 0.1;
const TOLERANCE = 0.03;

function chargeOf(provider: FakePaymentProvider, idempotencyKey: string) {
  return provider.charge({ bookingId: randomUUID(), amountCents: 1000, idempotencyKey });
}

describe('FakePaymentProvider', () => {
  it('the same key gets the same answer every time', async () => {
    const provider = new FakePaymentProvider(0.5);
    for (let i = 0; i < 50; i += 1) {
      const idempotencyKey = randomUUID();
      const first = await chargeOf(provider, idempotencyKey);
      expect(await chargeOf(provider, idempotencyKey)).toEqual(first);
    }
  });

  it('rate 0 never fails and rate 1 always fails', async () => {
    const never = new FakePaymentProvider(0);
    const always = new FakePaymentProvider(1);
    for (let i = 0; i < 200; i += 1) {
      const idempotencyKey = randomUUID();
      expect(await chargeOf(never, idempotencyKey)).toEqual({ succeeded: true });
      expect(await chargeOf(always, idempotencyKey)).toEqual({ succeeded: false });
    }
  });

  it('about the failure rate of all keys fail', async () => {
    const provider = new FakePaymentProvider(RATE);
    let failed = 0;
    for (let i = 0; i < KEYS; i += 1) {
      if (!(await chargeOf(provider, randomUUID())).succeeded) failed += 1;
    }
    expect(Math.abs(failed / KEYS - RATE)).toBeLessThan(TOLERANCE);
  });
});
