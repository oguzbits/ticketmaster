/**
 * Charges a booking, or throws `PaymentNotChargedError`. The idempotency key is the one the client
 * sent with the payment request. `refund` returns a charge that succeeded after its booking left
 * HELD, under its own key (`refundKey`); it throws when the money was not returned.
 */
export interface PaymentProvider {
  charge(input: {
    bookingId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ succeeded: boolean }>;
  refund(input: { bookingId: string; amountCents: number; idempotencyKey: string }): Promise<void>;
}

/** The idempotency key of the refund of the charge made under `chargeKey`. */
export const refundKey = (chargeKey: string): string => `refund:${chargeKey}`;

/**
 * Thrown by a provider that answered that it did not charge (a response, not a timeout or a lost
 * connection): the payment claim can be released. Any other error leaves the claim, because the
 * charge may have gone through.
 */
export class PaymentNotChargedError extends Error {}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * A HELD booking with a claimed payment key is spared by the expiry job until its hold is this far
 * past: a charge that started in time may still finish. After that it expires like any hold.
 */
export const PAYMENT_GRACE_SECONDS = 120;
