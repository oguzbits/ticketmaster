import { z } from 'zod';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;
const DEFAULT_HOLD_TTL_SECONDS = 600;
const DEFAULT_PAYMENT_FAILURE_RATE = 0.1;

export const NODE_ENV = {
  DEVELOPMENT: 'development',
  TEST: 'test',
  PRODUCTION: 'production',
} as const;

/** Ports of `docker-compose.yml`: what `pnpm db:up` starts. Used only outside production. */
const LOCAL_DEFAULTS = {
  DATABASE_URL: 'postgres://app:app@localhost:54330/app',
  REDIS_URL: 'redis://localhost:63790',
};

export const EnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENV).default(NODE_ENV.DEVELOPMENT),
  PORT: z.coerce.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
  // Required here; parseEnv fills the local default when NODE_ENV is not production.
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(DEFAULT_HOLD_TTL_SECONDS),
  PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(DEFAULT_PAYMENT_FAILURE_RATE),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validates a raw environment. On failure the message lists variable names and reasons only,
 * never the values, so a secret cannot end up in a log. Outside production a missing connection
 * URL takes its local default; in production it fails the start.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const withDefaults =
    raw.NODE_ENV === NODE_ENV.PRODUCTION
      ? raw
      : {
          ...raw,
          DATABASE_URL: raw.DATABASE_URL ?? LOCAL_DEFAULTS.DATABASE_URL,
          REDIS_URL: raw.REDIS_URL ?? LOCAL_DEFAULTS.REDIS_URL,
        };
  const result = EnvSchema.safeParse(withDefaults);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment: ${problems.join('; ')}`);
}
