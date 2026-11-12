/** Source of the current time. Injected, so hold TTL and expiry are testable without waiting. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');
