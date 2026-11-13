import { z } from 'zod';

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

export const SimulationStatusSchema = z.enum(SIMULATION_STATUS);

export const StartSimulationRequestSchema = z.object({
  buyers: z
    .number()
    .int()
    .min(1)
    .max(SIMULATION_LIMITS.BUYERS_MAX)
    .default(SIMULATION_LIMITS.BUYERS_DEFAULT),
  seats: z
    .number()
    .int()
    .min(1)
    .max(SIMULATION_LIMITS.SEATS_MAX)
    .default(SIMULATION_LIMITS.SEATS_DEFAULT),
  strategy: BookingStrategySchema,
});

const count = z.number().nonnegative();

/** `doubleBookings` is counted in SQL when the run ends, so it is null until then. */
export const SimulationMetricsSchema = z.object({
  attempts: count,
  holds: count,
  conflicts: count,
  constraintViolations: count,
  retries: count,
  buyersDone: count,
  p50Ms: count,
  p95Ms: count,
  doubleBookings: z.number().int().nonnegative().nullable(),
});

export const SimulationProgressSchema = z.object({
  status: SimulationStatusSchema,
  metrics: SimulationMetricsSchema,
});

export const SimulationRunSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  strategy: BookingStrategySchema,
  buyers: z.number().int().positive(),
  seats: z.number().int().positive(),
  status: SimulationStatusSchema,
  metrics: SimulationMetricsSchema.nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export const SimulationListResponseSchema = z.array(SimulationRunSchema);

/** The queue message: only the run ID, the worker reads the parameters from the row. */
export const SimulationCommandSchema = z.object({ runId: z.uuid() });

export type SimulationStatus = z.infer<typeof SimulationStatusSchema>;
export type StartSimulationRequest = z.infer<typeof StartSimulationRequestSchema>;
export type SimulationMetrics = z.infer<typeof SimulationMetricsSchema>;
export type SimulationProgress = z.infer<typeof SimulationProgressSchema>;
export type SimulationRun = z.infer<typeof SimulationRunSchema>;
export type SimulationCommand = z.infer<typeof SimulationCommandSchema>;
