/** Charges a booking. The idempotency key is the one the client sent with the payment request. */
export interface PaymentProvider {
  charge(input: {
    bookingId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ succeeded: boolean }>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
