import { describe, expect, it } from 'vitest';

import { FakePaymentProvider } from './fake-payment.provider.js';

describe('FakePaymentProvider', () => {
  it('a random value below the failure rate fails, at or above succeeds', async () => {
    const rate = 0.1;
    const failing = new FakePaymentProvider(rate, () => 0.099);
    const boundary = new FakePaymentProvider(rate, () => rate);
    const passing = new FakePaymentProvider(rate, () => 0.9);

    expect(await failing.charge()).toEqual({ succeeded: false });
    expect(await boundary.charge()).toEqual({ succeeded: true });
    expect(await passing.charge()).toEqual({ succeeded: true });
  });
});
