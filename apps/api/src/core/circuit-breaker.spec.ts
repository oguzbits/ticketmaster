import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from './circuit-breaker.js';

const THRESHOLD = 3;
const OPEN_MS = 1000;
const NOW = 5000;

const breakerAfter = (failures: number) => {
  const breaker = new CircuitBreaker(THRESHOLD, OPEN_MS);
  for (let i = 0; i < failures; i += 1) breaker.failure(NOW);
  return breaker;
};

describe('CircuitBreaker', () => {
  it('stays closed below the threshold and says so on each failure', () => {
    const breaker = new CircuitBreaker(THRESHOLD, OPEN_MS);

    expect([breaker.failure(NOW), breaker.failure(NOW)]).toEqual([false, false]);
    expect(breaker.isOpen(NOW)).toBe(false);
  });

  it('opens at the threshold, exactly until the window has passed', () => {
    const breaker = breakerAfter(THRESHOLD - 1);

    expect(breaker.failure(NOW)).toBe(true);

    expect(breaker.isOpen(NOW)).toBe(true);
    expect(breaker.isOpen(NOW + OPEN_MS - 1)).toBe(true);
    expect(breaker.isOpen(NOW + OPEN_MS)).toBe(false);
  });

  it('a success resets the count', () => {
    const breaker = breakerAfter(THRESHOLD - 1);

    breaker.success();

    expect(breaker.failure(NOW)).toBe(false);
    expect(breaker.isOpen(NOW)).toBe(false);
  });

  it('one failure after the window opens it again', () => {
    const breaker = breakerAfter(THRESHOLD);
    const later = NOW + OPEN_MS;

    expect(breaker.failure(later)).toBe(true);

    expect(breaker.isOpen(later + OPEN_MS - 1)).toBe(true);
  });
});
