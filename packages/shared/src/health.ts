import { z } from 'zod';

export const HEALTH_STATUS = {
  UP: 'UP',
  DOWN: 'DOWN',
} as const;

/**
 * Answer of `GET /health/live` (the process serves requests) and `GET /health/ready` (Postgres
 * and Redis answer; the status is 503 with `DOWN` otherwise).
 */
export const HealthResponseSchema = z.object({
  status: z.enum(HEALTH_STATUS),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
