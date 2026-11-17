import { array, enum as zEnum, type infer as ZodInfer, iso, number, object, url, uuid } from 'zod';

import { BookingStrategySchema } from './booking.js';

export const SIMULATION_STATUS = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  FINISHED: 'FINISHED',
  FAILED: 'FAILED',
} as const;

export const SIMULATION_LIMITS = {
  BUYERS_MAX: 2000,
  SEATS_MAX: 500,
  BUYERS_DEFAULT: 500,
  SEATS_DEFAULT: 100,
} as const;

/** Redis stream of the start commands; the worker reads it through a consumer group. */
export const SIMULATION_STREAM_KEY = 'simulations';
export const SIMULATION_CONSUMER_GROUP = 'simulation-workers';

export const SimulationStatusSchema = zEnum(SIMULATION_STATUS);

export const StartSimulationRequestSchema = object({
  buyers: number()
    .int()
    .min(1)
    .max(SIMULATION_LIMITS.BUYERS_MAX)
    .default(SIMULATION_LIMITS.BUYERS_DEFAULT),
  seats: number()
    .int()
    .min(1)
    .max(SIMULATION_LIMITS.SEATS_MAX)
    .default(SIMULATION_LIMITS.SEATS_DEFAULT),
  strategy: BookingStrategySchema,
});

const count = number().nonnegative();

/** `doubleBookings` is counted in SQL when the run ends, so it is null until then. */
export const SimulationMetricsSchema = object({
  attempts: count,
  holds: count,
  conflicts: count,
  constraintViolations: count,
  retries: count,
  buyersDone: count,
  p50Ms: count,
  p95Ms: count,
  doubleBookings: number().int().nonnegative().nullable(),
});

export const SimulationProgressSchema = object({
  status: SimulationStatusSchema,
  metrics: SimulationMetricsSchema,
});

export const SimulationRunSchema = object({
  id: uuid(),
  eventId: uuid(),
  strategy: BookingStrategySchema,
  buyers: number().int().positive(),
  seats: number().int().positive(),
  status: SimulationStatusSchema,
  metrics: SimulationMetricsSchema.nullable(),
  startedAt: iso.datetime(),
  finishedAt: iso.datetime().nullable(),
  /** Grafana Explore on the run's trace; null when tracing is off, no Grafana URL is set or the run has no trace. */
  traceUrl: url().nullable(),
});

export const SimulationListResponseSchema = array(SimulationRunSchema);

/** The queue message: only the run ID, the worker reads the parameters from the row. */
export const SimulationCommandSchema = object({ runId: uuid() });

export type SimulationStatus = ZodInfer<typeof SimulationStatusSchema>;
export type StartSimulationRequest = ZodInfer<typeof StartSimulationRequestSchema>;
export type SimulationMetrics = ZodInfer<typeof SimulationMetricsSchema>;
export type SimulationProgress = ZodInfer<typeof SimulationProgressSchema>;
export type SimulationRun = ZodInfer<typeof SimulationRunSchema>;
export type SimulationCommand = ZodInfer<typeof SimulationCommandSchema>;
