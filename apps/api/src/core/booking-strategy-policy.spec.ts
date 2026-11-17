import { BOOKING_STRATEGY } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { isStrategyAllowed, UNSAFE_STRATEGY_DISABLED_MESSAGE } from './booking-strategy-policy.js';

describe('isStrategyAllowed', () => {
  it('allows every strategy when unsafe strategies are enabled', () => {
    for (const strategy of Object.values(BOOKING_STRATEGY)) {
      expect(isStrategyAllowed(strategy, true)).toBe(true);
    }
  });

  it('refuses NAIVE and allows all safe strategies when unsafe strategies are disabled', () => {
    expect(isStrategyAllowed(BOOKING_STRATEGY.NAIVE, false)).toBe(false);
    expect(isStrategyAllowed(BOOKING_STRATEGY.PESSIMISTIC, false)).toBe(true);
    expect(isStrategyAllowed(BOOKING_STRATEGY.OPTIMISTIC, false)).toBe(true);
    expect(isStrategyAllowed(BOOKING_STRATEGY.REDIS_LOCK, false)).toBe(true);
    expect(UNSAFE_STRATEGY_DISABLED_MESSAGE).toBe(
      `Booking strategy ${BOOKING_STRATEGY.NAIVE} is disabled in this environment`
    );
  });
});
