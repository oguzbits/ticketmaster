import { BOOKING_STRATEGY } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { strategyLabel } from './strategy-label';

describe('strategyLabel', () => {
  it.each([
    [BOOKING_STRATEGY.NAIVE, 'Naive, no lock'],
    [BOOKING_STRATEGY.PESSIMISTIC, 'Row lock'],
    [BOOKING_STRATEGY.OPTIMISTIC, 'Optimistic version'],
    [BOOKING_STRATEGY.REDIS_LOCK, 'Redis lock'],
  ])('maps %s to %s', (strategy, label) => {
    expect(strategyLabel(strategy)).toBe(label);
  });
});
