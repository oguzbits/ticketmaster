import { z } from 'zod';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;
const DEFAULT_HOLD_TTL_SECONDS = 600;
const DEFAULT_PAYMENT_FAILURE_RATE = 0.1;
const DEFAULT_KEYCLOAK_REALM = 'ticketmaster';
const DEFAULT_KEYCLOAK_DEMO_CLIENT_ID = 'api-demo';
const DEFAULT_DEMO_USER_TTL_SECONDS = 3600;

export const NODE_ENV = {
  DEVELOPMENT: 'development',
  TEST: 'test',
  PRODUCTION: 'production',
} as const;

/**
 * Ports and credentials of `docker-compose.yml` and `docker/keycloak/ticketmaster-realm.json`:
 * local containers only. Used only outside production.
 */
const LOCAL_DEFAULTS = {
  DATABASE_URL: 'postgres://app:app@localhost:54330/app',
  REDIS_URL: 'redis://localhost:63790',
  KEYCLOAK_URL: 'http://localhost:8081',
  KEYCLOAK_DEMO_CLIENT_SECRET: 'local-demo-client-secret',
};

export const EnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENV).default(NODE_ENV.DEVELOPMENT),
  PORT: z.coerce.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
  // Required here; parseEnv fills the local default when NODE_ENV is not production.
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(DEFAULT_HOLD_TTL_SECONDS),
  PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(DEFAULT_PAYMENT_FAILURE_RATE),
  // Unset means no CORS headers at all (web and API share an origin behind Caddy).
  CORS_ORIGIN: z.url().optional(),
  // Built into `${KEYCLOAK_URL}/realms/...`: a trailing slash would give `//realms` and a wrong issuer.
  KEYCLOAK_URL: z.url().transform((url) => url.replace(/\/+$/, '')),
  KEYCLOAK_REALM: z.string().min(1).default(DEFAULT_KEYCLOAK_REALM),
  KEYCLOAK_DEMO_CLIENT_ID: z.string().min(1).default(DEFAULT_KEYCLOAK_DEMO_CLIENT_ID),
  KEYCLOAK_DEMO_CLIENT_SECRET: z.string().min(1),
  DEMO_USER_TTL_SECONDS: z.coerce.number().int().positive().default(DEFAULT_DEMO_USER_TTL_SECONDS),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validates a raw environment. On failure the message lists variable names and reasons only,
 * never the values, so a secret cannot end up in a log. Outside production a missing connection
 * URL or Keycloak setting takes its local default; in production it fails the start.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const withDefaults =
    raw.NODE_ENV === NODE_ENV.PRODUCTION
      ? raw
      : {
          ...raw,
          DATABASE_URL: raw.DATABASE_URL ?? LOCAL_DEFAULTS.DATABASE_URL,
          REDIS_URL: raw.REDIS_URL ?? LOCAL_DEFAULTS.REDIS_URL,
          KEYCLOAK_URL: raw.KEYCLOAK_URL ?? LOCAL_DEFAULTS.KEYCLOAK_URL,
          KEYCLOAK_DEMO_CLIENT_SECRET:
            raw.KEYCLOAK_DEMO_CLIENT_SECRET ?? LOCAL_DEFAULTS.KEYCLOAK_DEMO_CLIENT_SECRET,
        };
  const result = EnvSchema.safeParse(withDefaults);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment: ${problems.join('; ')}`);
}
