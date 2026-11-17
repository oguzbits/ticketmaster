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
  it('stays closed below the threshold and allows repeated calls', () => {
    const breaker = new CircuitBreaker(THRESHOLD, OPEN_MS);

    expect([breaker.failure(NOW), breaker.failure(NOW)]).toEqual([false, false]);
    expect([breaker.allow(NOW), breaker.allow(NOW)]).toEqual([true, true]);
  });

  it('opens at the threshold until the window has passed, then admits one probe', () => {
    const breaker = breakerAfter(THRESHOLD - 1);

    expect(breaker.failure(NOW)).toBe(true);

    expect(breaker.allow(NOW)).toBe(false);
    expect(breaker.allow(NOW + OPEN_MS - 1)).toBe(false);
    expect(breaker.allow(NOW + OPEN_MS)).toBe(true);
    expect(breaker.allow(NOW + OPEN_MS)).toBe(false);
  });

  it('a success resets the count and closes the breaker after a probe', () => {
    const breaker = breakerAfter(THRESHOLD);

    expect(breaker.allow(NOW + OPEN_MS)).toBe(true);
    breaker.success();

    expect([breaker.allow(NOW + OPEN_MS), breaker.allow(NOW + OPEN_MS)]).toEqual([true, true]);
    expect(breaker.failure(NOW + OPEN_MS)).toBe(false);
    expect(breaker.allow(NOW + OPEN_MS)).toBe(true);
  });

  it('one failure on the probe opens it again for another window', () => {
    const breaker = breakerAfter(THRESHOLD);
    const later = NOW + OPEN_MS;

    expect(breaker.allow(later)).toBe(true);
    expect(breaker.failure(later)).toBe(true);

    expect(breaker.allow(later + OPEN_MS - 1)).toBe(false);
    expect(breaker.allow(later + OPEN_MS)).toBe(true);
  });
});
