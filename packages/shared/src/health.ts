import { boolean, enum as zEnum, type infer as ZodInfer, object } from 'zod';

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
export const HealthResponseSchema = object({
  status: zEnum(HEALTH_STATUS),
  signals: object({ outbox: zEnum(OUTBOX_SIGNAL) }).optional(),
  tracing: boolean().optional(),
});

export type HealthResponse = ZodInfer<typeof HealthResponseSchema>;
