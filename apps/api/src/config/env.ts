import { z } from 'zod';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;
const DEFAULT_HOLD_TTL_SECONDS = 600;
const DEFAULT_PAYMENT_FAILURE_RATE = 0.1;
const DEFAULT_KEYCLOAK_REALM = 'ticketmaster';
const DEFAULT_KEYCLOAK_DEMO_CLIENT_ID = 'api-demo';
const DEFAULT_DEMO_USER_TTL_SECONDS = 3600;
const DEFAULT_AWS_REGION = 'us-east-1';
const DEFAULT_MAIL_FROM = 'tickets@ticketmaster-klon.invalid';
const DEFAULT_TRACING_OTLP_ENDPOINT = 'http://localhost:4318';
const DEFAULT_METRICS_PORT = 9464;
const DEFAULT_METRICS_HOST = '127.0.0.1';
const DEFAULT_EVENT_CACHE_TTL_SECONDS = 30;
const DEFAULT_RATE_LIMIT_SCALE = 1;

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
  // The runtime login: no superuser, no owner, so row-level security applies to it.
  DATABASE_URL: 'postgres://app_runtime:app_runtime@localhost:54330/app',
  // The owner login of the migrations (docker-compose.yml, POSTGRES_USER).
  MIGRATION_DATABASE_URL: 'postgres://app:app@localhost:54330/app',
  REDIS_URL: 'redis://localhost:63790',
  KEYCLOAK_URL: 'http://localhost:8081',
  KEYCLOAK_DEMO_CLIENT_SECRET: 'local-demo-client-secret',
  // The emulator accepts any credentials.
  AWS_ENDPOINT_URL: 'http://localhost:45660',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  // Mailpit of docker-compose.yml.
  SMTP_URL: 'smtp://localhost:1025',
  // Enabled locally for the demo and strategy comparison; off by default in production.
  DEMO_LOGIN_ENABLED: 'true',
  UNSAFE_STRATEGIES_ENABLED: 'true',
};

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENV).default(NODE_ENV.DEVELOPMENT),
    PORT: z.coerce.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
    // Required here; parseEnv fills the local default when NODE_ENV is not production.
    DATABASE_URL: z.url(),
    // Owner login for the migration job only; optional so that API and worker need not carry it.
    MIGRATION_DATABASE_URL: z.url().optional(),
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
    DEMO_USER_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_DEMO_USER_TTL_SECONDS),
    // Off by default in production; local Compose and development enable the demo login explicitly.
    DEMO_LOGIN_ENABLED: z.stringbool().default(false),
    // Off by default in production; prevents configuring or holding under the NAIVE strategy.
    UNSAFE_STRATEGIES_ENABLED: z.stringbool().default(false),
    // Unset in production means real AWS; parseEnv fills the local emulator otherwise.
    AWS_ENDPOINT_URL: z.url().optional(),
    // Optional origin/path prefix for presigned S3 ticket URLs (e.g. `/storage` behind Caddy).
    S3_PRESIGN_BASE_URL: z
      .string()
      .min(1)
      .transform((base) => base.replace(/\/+$/, ''))
      .optional(),
    AWS_REGION: z.string().min(1).default(DEFAULT_AWS_REGION),
    AWS_ACCESS_KEY_ID: z.string().min(1),
    AWS_SECRET_ACCESS_KEY: z.string().min(1),
    // Required here; parseEnv fills the local mail sink when NODE_ENV is not production.
    SMTP_URL: z.url(),
    MAIL_FROM: z.email().default(DEFAULT_MAIL_FROM),
    // Off by default and in every test: nothing is hooked, exported or subscribed.
    TRACING_ENABLED: z.stringbool().default(false),
    // Base URL of an OTLP/HTTP receiver; '/v1/traces' is appended, so a trailing slash is stripped.
    TRACING_OTLP_ENDPOINT: z
      .url()
      .default(DEFAULT_TRACING_OTLP_ENDPOINT)
      .transform((url) => url.replace(/\/+$/, '')),
    // Off by default and in every test: no provider, no exporter, no listening socket.
    METRICS_ENABLED: z.stringbool().default(false),
    // Port of the Prometheus scrape endpoint (`/metrics`); served by its own listener, never by the app.
    METRICS_PORT: z.coerce.number().int().min(1).max(MAX_PORT).default(DEFAULT_METRICS_PORT),
    // Interface of that listener. Loopback by default; Compose sets 0.0.0.0 so the scraper container
    // can reach it. The scrape holds counts per route template, no IDs and no personal data.
    METRICS_HOST: z.ipv4().default(DEFAULT_METRICS_HOST),
    // Lifetime of a cached event page in seconds; 0 switches the cache off (baseline load runs).
    EVENT_CACHE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .default(DEFAULT_EVENT_CACHE_TTL_SECONDS),
    // Multiplies every rate limit. 1 outside load runs; only docker-compose.loadtest.yml raises it,
    // and production refuses anything above 1.
    RATE_LIMIT_SCALE: z.coerce.number().int().min(1).default(DEFAULT_RATE_LIMIT_SCALE),
    // Base URL of Grafana as the admin's browser reaches it; unset hides the trace link of a run.
    GRAFANA_URL: z.url().optional(),
  })
  .superRefine((env, context) => {
    // A scaled limit is for local load runs; production keeps the real one.
    if (env.NODE_ENV === NODE_ENV.PRODUCTION && env.RATE_LIMIT_SCALE > 1) {
      context.addIssue({
        code: 'custom',
        path: ['RATE_LIMIT_SCALE'],
        message: 'must be 1 when NODE_ENV is production',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** The login the migration job uses; it never falls back to the runtime login. */
export function migrationDatabaseUrl(env: Env): string {
  if (env.MIGRATION_DATABASE_URL === undefined) {
    throw new Error('Invalid environment: MIGRATION_DATABASE_URL: required to run migrations');
  }
  return env.MIGRATION_DATABASE_URL;
}

/** Each variable of LOCAL_DEFAULTS that the environment leaves unset takes its local default. */
function fillLocalDefaults(raw: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(LOCAL_DEFAULTS).map(([name, fallback]) => [name, raw[name] ?? fallback])
  );
}

/**
 * Validates a raw environment. On failure the message lists variable names and reasons only,
 * never the values, so a secret cannot end up in a log. Outside production a missing connection
 * URL or Keycloak setting takes its local default; in production it fails the start.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const withDefaults =
    raw.NODE_ENV === NODE_ENV.PRODUCTION ? raw : { ...raw, ...fillLocalDefaults(raw) };
  const result = EnvSchema.safeParse(withDefaults);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment: ${problems.join('; ')}`);
}
