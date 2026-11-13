import { z } from 'zod';

export const HEALTH_STATUS = {
  UP: 'UP',
  DOWN: 'DOWN',
} as const;

/** State of the outbox as the ready probe sees it: `STUCK` when the oldest unpublished row is too old. */
export const OUTBOX_SIGNAL = {
  OK: 'ok',
  STUCK: 'stuck',
} as const;

/**
 * Answer of `GET /health/live` (the process serves requests) and `GET /health/ready` (Postgres
 * and Redis answer; the status is 503 with `DOWN` otherwise). The ready route adds `signals`: they
 * report trouble that must not take an instance out of rotation, so they never change the status.
 */
export const HealthResponseSchema = z.object({
  status: z.enum(HEALTH_STATUS),
  signals: z.object({ outbox: z.enum(OUTBOX_SIGNAL) }).optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
