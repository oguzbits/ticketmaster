import type { PaymentProvider } from '../domain/payment-provider.js';

/** Simulated charge: it fails when `random()` falls below the failure rate. No network involved. */
export class FakePaymentProvider implements PaymentProvider {
  constructor(
    private readonly failureRate: number,
    private readonly random: () => number
  ) {}

  async charge(): Promise<{ succeeded: boolean }> {
    return { succeeded: this.random() >= this.failureRate };
  }
}
