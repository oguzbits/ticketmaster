import { z } from 'zod';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;

export const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validates a raw environment. On failure the message lists variable names and reasons only,
 * never the values, so a secret cannot end up in a log.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment: ${problems.join('; ')}`);
}
