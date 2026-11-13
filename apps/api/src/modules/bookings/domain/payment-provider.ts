/** Charges a booking. The idempotency key is the one the client sent with the payment request. */
export interface PaymentProvider {
  charge(input: {
    bookingId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ succeeded: boolean }>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * A HELD booking with a claimed payment key is spared by the expiry job until its hold is this far
 * past: a charge that started in time may still finish. After that it expires like any hold.
 */
export const PAYMENT_GRACE_SECONDS = 120;
