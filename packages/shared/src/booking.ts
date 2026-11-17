import { z } from 'zod';

/** How a hold on a seat is protected against a second hold. `NAIVE` is the comparison baseline. */
export const BOOKING_STRATEGY = {
  NAIVE: 'NAIVE',
  PESSIMISTIC: 'PESSIMISTIC',
  OPTIMISTIC: 'OPTIMISTIC',
  REDIS_LOCK: 'REDIS_LOCK',
} as const;

export const BOOKING_STATUS = {
  HELD: 'HELD',
  PAID: 'PAID',
  CONFIRMED: 'CONFIRMED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

/** Derived from the bookings of a seat, never stored. */
export const SEAT_STATUS = {
  AVAILABLE: 'AVAILABLE',
  HELD: 'HELD',
  SOLD: 'SOLD',
} as const;

export const TRANSITION_REASON = {
  HOLD: 'HOLD',
  PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  CONFIRMED: 'CONFIRMED',
  HOLD_EXPIRED: 'HOLD_EXPIRED',
  CANCELLED_BY_USER: 'CANCELLED_BY_USER',
} as const;

export const PAYMENT_ATTEMPT_STATUS = {
  CLAIMED: 'CLAIMED',
  CHARGED: 'CHARGED',
  APPLIED: 'APPLIED',
  REFUND_PENDING: 'REFUND_PENDING',
  REFUNDED: 'REFUNDED',
  RELEASED: 'RELEASED',
} as const;

export const BookingStrategySchema = z.enum(BOOKING_STRATEGY);
export const BookingStatusSchema = z.enum(BOOKING_STATUS);
export const SeatStatusSchema = z.enum(SEAT_STATUS);
export const TransitionReasonSchema = z.enum(TRANSITION_REASON);
export const PaymentAttemptStatusSchema = z.enum(PAYMENT_ATTEMPT_STATUS);

export type BookingStrategy = z.infer<typeof BookingStrategySchema>;
export type BookingStatus = z.infer<typeof BookingStatusSchema>;
export type SeatStatus = z.infer<typeof SeatStatusSchema>;
export type TransitionReason = z.infer<typeof TransitionReasonSchema>;
export type PaymentAttemptStatus = z.infer<typeof PaymentAttemptStatusSchema>;
