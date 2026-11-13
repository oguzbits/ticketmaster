import type { SimulationMetrics } from '@app/shared';

import { SimulationMetricsRecorder } from './domain/simulation-metrics.js';

/** The worker writes the progress of a run under this key, the stream route reads it. */
export const simulationProgressKey = (runId: string): string => `simulation:${runId}:progress`;

/** The key outlives a run by this long; after that the final state is read from the row. */
export const SIMULATION_PROGRESS_TTL_SECONDS = 3600;

/** What a run that has not reported anything yet shows. */
export const EMPTY_METRICS: SimulationMetrics = {
  ...new SimulationMetricsRecorder().snapshot(),
  doubleBookings: null,
};
