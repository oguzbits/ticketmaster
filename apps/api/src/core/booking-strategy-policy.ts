import { BOOKING_STRATEGY, type BookingStrategy } from '@app/shared';

const UNSAFE_STRATEGIES: readonly BookingStrategy[] = [BOOKING_STRATEGY.NAIVE];

export const UNSAFE_STRATEGY_DISABLED_MESSAGE =
  'Booking strategy NAIVE is disabled in this environment';

/**
 * Checks whether `strategy` may be configured or used in the current environment.
 * `NAIVE` exists only for local comparison and must be refused when unsafe strategies are off.
 */
export function isStrategyAllowed(strategy: BookingStrategy, unsafeEnabled: boolean): boolean {
  return unsafeEnabled || !UNSAFE_STRATEGIES.includes(strategy);
}
