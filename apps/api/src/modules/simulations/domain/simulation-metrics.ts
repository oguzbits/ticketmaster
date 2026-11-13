import type { SimulationMetrics } from '@app/shared';

/** The counter of the metrics that one attempt of a buyer ends in. */
export const ATTEMPT_COUNTER = {
  HOLD: 'holds',
  CONFLICT: 'conflicts',
  CONSTRAINT_VIOLATION: 'constraintViolations',
} as const;

export type AttemptCounter = (typeof ATTEMPT_COUNTER)[keyof typeof ATTEMPT_COUNTER];

/** Nearest-rank percentile (`p` in 0..100); 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  // SAFETY: rank is between 1 and sorted.length, so the index is inside the non-empty array.
  return sorted[rank - 1] as number;
}

/** Counts what the buyers of one run experience. `doubleBookings` is not here: SQL counts it. */
export class SimulationMetricsRecorder {
  private readonly counters: Record<AttemptCounter, number> = {
    holds: 0,
    conflicts: 0,
    constraintViolations: 0,
  };
  private readonly latenciesMs: number[] = [];
  private retries = 0;
  private buyersDone = 0;

  record(counter: AttemptCounter, latencyMs: number, isRetry: boolean): void {
    this.counters[counter] += 1;
    this.latenciesMs.push(latencyMs);
    if (isRetry) this.retries += 1;
  }

  buyerDone(): void {
    this.buyersDone += 1;
  }

  snapshot(): Omit<SimulationMetrics, 'doubleBookings'> {
    return {
      attempts: this.latenciesMs.length,
      ...this.counters,
      retries: this.retries,
      buyersDone: this.buyersDone,
      p50Ms: percentile(this.latenciesMs, 50),
      p95Ms: percentile(this.latenciesMs, 95),
    };
  }
}
