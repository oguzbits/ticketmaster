import { z } from 'zod';

export const HEALTH_STATUS = {
  UP: 'UP',
} as const;

/** Answer of `GET /health/live`: the process is running and serves requests. */
export const HealthResponseSchema = z.object({
  status: z.enum(HEALTH_STATUS),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
