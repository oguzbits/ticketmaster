import { describe, expect, it } from 'vitest';

import { ATTEMPT_COUNTER, percentile, SimulationMetricsRecorder } from './simulation-metrics.js';

describe('percentile', () => {
  it('is 0 for an empty list', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('is the only value of a one-value list', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
  });

  it('uses the nearest rank', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
  });

  it('sorts the input and leaves it unchanged', () => {
    const values = [9, 1, 5, 3, 7];
    expect(percentile(values, 50)).toBe(5);
    expect(values).toEqual([9, 1, 5, 3, 7]);
  });

  it('is the minimum at p=0', () => {
    expect(percentile([3, 9, 1], 0)).toBe(1);
  });

  it('is the maximum at p=100', () => {
    expect(percentile([3, 9, 1], 100)).toBe(9);
  });
});

describe('SimulationMetricsRecorder', () => {
  it.each(Object.values(ATTEMPT_COUNTER))(
    'an attempt of kind %s lands in exactly one counter',
    (kind) => {
      const recorder = new SimulationMetricsRecorder();
      recorder.record(kind, 5, false);

      const snapshot = recorder.snapshot();
      const counters = {
        holds: snapshot.holds,
        conflicts: snapshot.conflicts,
        constraintViolations: snapshot.constraintViolations,
      };
      expect(counters).toEqual({ holds: 0, conflicts: 0, constraintViolations: 0, [kind]: 1 });
      expect(snapshot.attempts).toBe(1);
    }
  );

  it('counts attempts as the sum of outcomes and retries only when flagged', () => {
    const recorder = new SimulationMetricsRecorder();
    recorder.record(ATTEMPT_COUNTER.CONFLICT, 1, false);
    recorder.record(ATTEMPT_COUNTER.CONFLICT, 1, true);
    recorder.record(ATTEMPT_COUNTER.HOLD, 1, true);
    recorder.record(ATTEMPT_COUNTER.CONSTRAINT_VIOLATION, 1, false);
    recorder.buyerDone();

    const s = recorder.snapshot();
    expect(s.attempts).toBe(4);
    expect(s.holds + s.conflicts + s.constraintViolations).toBe(s.attempts);
    expect(s.retries).toBe(2);
    expect(s.buyersDone).toBe(1);
  });

  it('reports p50 and p95 of the recorded latencies', () => {
    const recorder = new SimulationMetricsRecorder();
    for (let ms = 1; ms <= 20; ms += 1) recorder.record(ATTEMPT_COUNTER.HOLD, ms, false);

    expect(recorder.snapshot()).toMatchObject({ p50Ms: 10, p95Ms: 19 });
  });
});
