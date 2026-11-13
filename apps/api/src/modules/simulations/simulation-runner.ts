import type { SimulationMetrics } from '@app/shared';

import type { Clock } from '../../core/clock.js';
import { type BookingsService, HOLD_OUTCOME, type HoldResult } from '../bookings/index.js';
import {
  ATTEMPT_COUNTER,
  type AttemptCounter,
  SimulationMetricsRecorder,
} from './domain/simulation-metrics.js';

/** A buyer who finds his seat taken tries another one, this many attempts in all. */
export const MAX_ATTEMPTS_PER_BUYER = 3;
/**
 * Buyers in flight at once. The database pool must allow it: with fewer connections the pool queue
 * serializes the buyers and `naive` stops racing.
 */
export const SIMULATION_CONCURRENCY = 40;

const COUNTER_OF_OUTCOME: Record<HoldResult['outcome'], AttemptCounter> = {
  [HOLD_OUTCOME.PLACED]: ATTEMPT_COUNTER.HOLD,
  [HOLD_OUTCOME.SEAT_TAKEN]: ATTEMPT_COUNTER.CONFLICT,
  [HOLD_OUTCOME.CONSTRAINT_VIOLATION]: ATTEMPT_COUNTER.CONSTRAINT_VIOLATION,
};

export interface SimulationRunnerDeps {
  bookings: Pick<BookingsService, 'hold' | 'countDoubleBookings'>;
  clock: Clock;
  /** Uniform in [0, 1): picks the seat of an attempt. */
  random: () => number;
  /** A fresh synthetic user ID per buyer. */
  newUserId: () => string;
  /** How often `onProgress` fires while the run is going. */
  intervalMs: number;
}

export interface SimulationRunInput {
  runId: string;
  eventId: string;
  buyers: number;
  seats: readonly string[];
  concurrency: number;
  /**
   * Every buyer books as this user instead of a synthetic one. A sandbox event accepts bookings
   * only from its owner, and the run's event is the starting admin's sandbox.
   */
  buyerId?: string;
  onProgress(metrics: SimulationMetrics): void;
}

/** Runs virtual buyers against `BookingsService.hold`, no HTTP; the buyers are synthetic users. */
export class SimulationRunner {
  constructor(private readonly deps: SimulationRunnerDeps) {}

  /** Resolves with the final metrics; a failing hold stops the run and rejects (nothing is hidden). */
  async run(input: SimulationRunInput): Promise<SimulationMetrics> {
    const { seats, buyers, onProgress } = input;
    if (seats.length === 0) throw new Error('a simulation needs at least one seat');
    const recorder = new SimulationMetricsRecorder();
    const timer = setInterval(
      () => onProgress({ ...recorder.snapshot(), doubleBookings: null }),
      this.deps.intervalMs
    );
    let nextBuyer = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
      while (!failed && nextBuyer < buyers) {
        nextBuyer += 1;
        try {
          await this.runBuyer(input, recorder);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(input.concurrency, buyers) }, worker));
    } finally {
      clearInterval(timer);
    }
    const doubleBookings = await this.deps.bookings.countDoubleBookings(input.eventId);
    const finalMetrics = { ...recorder.snapshot(), doubleBookings };
    onProgress(finalMetrics);
    return finalMetrics;
  }

  private async runBuyer(input: SimulationRunInput, recorder: SimulationMetricsRecorder) {
    const userId = input.buyerId ?? this.deps.newUserId();
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_BUYER; attempt += 1) {
      const seatId = input.seats[Math.floor(this.deps.random() * input.seats.length)];
      if (seatId === undefined) throw new Error('the random source left the range [0, 1)');
      const started = this.deps.clock.now().getTime();
      const result = await this.deps.bookings.hold({ eventId: input.eventId, seatId, userId });
      const latencyMs = this.deps.clock.now().getTime() - started;
      recorder.record(COUNTER_OF_OUTCOME[result.outcome], latencyMs, attempt > 0);
      if (result.outcome === HOLD_OUTCOME.PLACED) break;
    }
    recorder.buyerDone();
  }
}
