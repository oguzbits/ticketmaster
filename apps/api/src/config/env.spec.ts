import { describe, expect, it } from 'vitest';

import { migrationDatabaseUrl, parseEnv } from './env.js';

const LOCAL_DATABASE_URL = 'postgres://app_runtime:app_runtime@localhost:54330/app';
const LOCAL_MIGRATION_DATABASE_URL = 'postgres://app:app@localhost:54330/app';
const LOCAL_REDIS_URL = 'redis://localhost:63790';
const LOCAL_KEYCLOAK_URL = 'http://localhost:8081';
const LOCAL_KEYCLOAK_SECRET = 'local-demo-client-secret';
const LOCAL_AWS_ENDPOINT_URL = 'http://localhost:45660';
const LOCAL_AWS_CREDENTIAL = 'test';
const LOCAL_SMTP_URL = 'smtp://localhost:1025';
const DEFAULT_MAIL_FROM = 'tickets@ticketmaster-klon.invalid';
const LOCAL_OTLP_ENDPOINT = 'http://localhost:4318';
const LOCAL_WAITING_ROOM_SIGNING_SECRET = 'local-waiting-room-signing-secret-0000';

const PRODUCTION_BASE = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db:5432/app',
  REDIS_URL: 'redis://cache:6379',
  AWS_ACCESS_KEY_ID: 'prod-key-id',
  AWS_SECRET_ACCESS_KEY: 'prod-secret-key',
  SMTP_URL: 'smtp://mail:1025',
  WAITING_ROOM_SIGNING_SECRET: 'prod-waiting-room-signing-secret-00',
};

const KEYCLOAK_PRODUCTION = {
  KEYCLOAK_URL: 'http://keycloak:8080',
  KEYCLOAK_DEMO_CLIENT_SECRET: 'prod-keycloak-secret',
};

describe('parseEnv', () => {
  it('coerces values from strings and fills in defaults', () => {
    expect(parseEnv({ PORT: '8080' }).PORT).toBe(8080);
    expect(parseEnv({})).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: LOCAL_DATABASE_URL,
      MIGRATION_DATABASE_URL: LOCAL_MIGRATION_DATABASE_URL,
      REDIS_URL: LOCAL_REDIS_URL,
      HOLD_TTL_SECONDS: 600,
      PAYMENT_FAILURE_RATE: 0.1,
      KEYCLOAK_URL: LOCAL_KEYCLOAK_URL,
      KEYCLOAK_REALM: 'ticketmaster',
      KEYCLOAK_DEMO_CLIENT_ID: 'api-demo',
      KEYCLOAK_DEMO_CLIENT_SECRET: LOCAL_KEYCLOAK_SECRET,
      DEMO_USER_TTL_SECONDS: 3600,
      DEMO_LOGIN_ENABLED: true,
      UNSAFE_STRATEGIES_ENABLED: true,
      WAITING_ROOM_SIGNING_SECRET: LOCAL_WAITING_ROOM_SIGNING_SECRET,
      AWS_ENDPOINT_URL: LOCAL_AWS_ENDPOINT_URL,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: LOCAL_AWS_CREDENTIAL,
      AWS_SECRET_ACCESS_KEY: LOCAL_AWS_CREDENTIAL,
      MAIL_PROVIDER: 'smtp',
      SMTP_URL: LOCAL_SMTP_URL,
      MAIL_FROM: DEFAULT_MAIL_FROM,
      TRACING_ENABLED: false,
      TRACING_OTLP_ENDPOINT: LOCAL_OTLP_ENDPOINT,
      METRICS_ENABLED: false,
      METRICS_PORT: 9464,
      METRICS_HOST: '127.0.0.1',
      EVENT_CACHE_TTL_SECONDS: 30,
      RATE_LIMIT_SCALE: 1,
    });
  });

  it('names the invalid variable but never prints its value', () => {
    expect(() => parseEnv({ PORT: 'secret-value' })).toThrow(/^(?!.*secret-value).*PORT/s);
  });

  it('uses the local connection defaults in development', () => {
    const env = parseEnv({ NODE_ENV: 'development' });

    expect(env.DATABASE_URL).toBe(LOCAL_DATABASE_URL);
    expect(env.REDIS_URL).toBe(LOCAL_REDIS_URL);
  });

  it('uses the local Keycloak defaults outside production', () => {
    const env = parseEnv({ NODE_ENV: 'test' });

    expect(env.KEYCLOAK_URL).toBe(LOCAL_KEYCLOAK_URL);
    expect(env.KEYCLOAK_DEMO_CLIENT_SECRET).toBe(LOCAL_KEYCLOAK_SECRET);
  });

  it('strips trailing slashes from KEYCLOAK_URL so URLs built from it have no double slash', () => {
    expect(parseEnv({ KEYCLOAK_URL: 'http://keycloak:8080/' }).KEYCLOAK_URL).toBe(
      'http://keycloak:8080'
    );
    expect(parseEnv({ KEYCLOAK_URL: 'http://keycloak:8080//' }).KEYCLOAK_URL).toBe(
      'http://keycloak:8080'
    );
  });

  it('production without KEYCLOAK_DEMO_CLIENT_SECRET throws and names the variable, not a value', () => {
    const raw = { ...PRODUCTION_BASE, KEYCLOAK_URL: 'http://secret-host:8080' };

    expect(() => parseEnv(raw)).toThrow(/^(?!.*secret-host).*KEYCLOAK_DEMO_CLIENT_SECRET/s);
  });

  it('production without KEYCLOAK_URL throws and names the variable', () => {
    const raw = { ...PRODUCTION_BASE, KEYCLOAK_DEMO_CLIENT_SECRET: 'prod-secret' };

    expect(() => parseEnv(raw)).toThrow(/^(?!.*prod-secret).*KEYCLOAK_URL/s);
  });

  it('CORS_ORIGIN is optional and must be a URL when set', () => {
    expect(parseEnv({}).CORS_ORIGIN).toBeUndefined();
    expect(parseEnv({ CORS_ORIGIN: 'https://app.example.com' }).CORS_ORIGIN).toBe(
      'https://app.example.com'
    );
    expect(() => parseEnv({ CORS_ORIGIN: 'not a url' })).toThrow(/^(?!.*not a url).*CORS_ORIGIN/s);
  });

  it('DEMO_USER_TTL_SECONDS must be a positive integer', () => {
    expect(() => parseEnv({ DEMO_USER_TTL_SECONDS: '0' })).toThrow(/DEMO_USER_TTL_SECONDS/);
  });

  describe('MIGRATION_DATABASE_URL', () => {
    it('is the owner login in development, apart from the runtime login', () => {
      const env = parseEnv({});

      expect(migrationDatabaseUrl(env)).toBe(LOCAL_MIGRATION_DATABASE_URL);
      expect(migrationDatabaseUrl(env)).not.toBe(env.DATABASE_URL);
    });

    it('stays optional in production, so the API and the worker need not carry the owner login', () => {
      expect(parseEnv({ ...PRODUCTION_BASE, ...KEYCLOAK_PRODUCTION }).MIGRATION_DATABASE_URL).toBe(
        undefined
      );
    });

    it('is required by the migration in production and never falls back to the runtime login', () => {
      const env = parseEnv({ ...PRODUCTION_BASE, ...KEYCLOAK_PRODUCTION });

      expect(() => migrationDatabaseUrl(env)).toThrow(/MIGRATION_DATABASE_URL/);
    });
  });

  it('production without DATABASE_URL throws and names the variable, not a value', () => {
    const raw = { NODE_ENV: 'production', REDIS_URL: 'redis://secret-host:6379' };

    expect(() => parseEnv(raw)).toThrow(/^(?!.*secret-host).*DATABASE_URL/s);
  });

  it('production without REDIS_URL throws and names the variable', () => {
    const raw = { NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db:5432/app' };

    expect(() => parseEnv(raw)).toThrow(/REDIS_URL/);
  });

  it('production takes the connection and Keycloak settings from the environment', () => {
    const raw = {
      ...PRODUCTION_BASE,
      KEYCLOAK_URL: 'http://keycloak:8080',
      KEYCLOAK_DEMO_CLIENT_SECRET: 'prod-secret',
    };

    expect(parseEnv(raw)).toMatchObject({
      DATABASE_URL: raw.DATABASE_URL,
      REDIS_URL: raw.REDIS_URL,
      KEYCLOAK_URL: raw.KEYCLOAK_URL,
      KEYCLOAK_DEMO_CLIENT_SECRET: raw.KEYCLOAK_DEMO_CLIENT_SECRET,
    });
  });

  it('PAYMENT_FAILURE_RATE above 1 is rejected', () => {
    expect(() => parseEnv({ PAYMENT_FAILURE_RATE: '1.5' })).toThrow(/PAYMENT_FAILURE_RATE/);
  });

  it('EVENT_CACHE_TTL_SECONDS accepts 0 (cache off) and rejects a negative number', () => {
    expect(parseEnv({ EVENT_CACHE_TTL_SECONDS: '0' }).EVENT_CACHE_TTL_SECONDS).toBe(0);
    expect(() => parseEnv({ EVENT_CACHE_TTL_SECONDS: '-1' })).toThrow(/EVENT_CACHE_TTL_SECONDS/);
  });

  describe('RATE_LIMIT_SCALE', () => {
    const production = { ...PRODUCTION_BASE, ...KEYCLOAK_PRODUCTION };

    it('is refused above 1 in production, naming the variable', () => {
      expect(() => parseEnv({ ...production, RATE_LIMIT_SCALE: '1000' })).toThrow(
        /RATE_LIMIT_SCALE/
      );
    });

    it('is accepted above 1 in development and as 1 in production', () => {
      expect(parseEnv({ NODE_ENV: 'development', RATE_LIMIT_SCALE: '1000' }).RATE_LIMIT_SCALE).toBe(
        1000
      );
      expect(parseEnv({ ...production, RATE_LIMIT_SCALE: '1' }).RATE_LIMIT_SCALE).toBe(1);
    });

    it('is refused at 0', () => {
      expect(() => parseEnv({ RATE_LIMIT_SCALE: '0' })).toThrow(/RATE_LIMIT_SCALE/);
    });
  });

  it('HOLD_TTL_SECONDS must be a positive integer', () => {
    expect(() => parseEnv({ HOLD_TTL_SECONDS: '0' })).toThrow(/HOLD_TTL_SECONDS/);
  });

  it('uses the local AWS emulator and its dummy credentials outside production', () => {
    const env = parseEnv({ NODE_ENV: 'test' });

    expect(env.AWS_ENDPOINT_URL).toBe(LOCAL_AWS_ENDPOINT_URL);
    expect(env.AWS_ACCESS_KEY_ID).toBe(LOCAL_AWS_CREDENTIAL);
    expect(env.AWS_SECRET_ACCESS_KEY).toBe(LOCAL_AWS_CREDENTIAL);
  });

  it('production without AWS_ENDPOINT_URL leaves it unset, which means real AWS', () => {
    expect(
      parseEnv({ ...PRODUCTION_BASE, ...KEYCLOAK_PRODUCTION }).AWS_ENDPOINT_URL
    ).toBeUndefined();
  });

  it('production takes the AWS settings from the environment', () => {
    const raw = { ...PRODUCTION_BASE, ...KEYCLOAK_PRODUCTION, AWS_ENDPOINT_URL: 'http://aws:4566' };

    expect(parseEnv(raw)).toMatchObject({
      AWS_ENDPOINT_URL: 'http://aws:4566',
      AWS_ACCESS_KEY_ID: PRODUCTION_BASE.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: PRODUCTION_BASE.AWS_SECRET_ACCESS_KEY,
    });
  });

  it('production without AWS_ACCESS_KEY_ID throws and names the variable, not a value', () => {
    const { AWS_ACCESS_KEY_ID: _omitted, ...raw } = PRODUCTION_BASE;

    expect(() => parseEnv({ ...raw, ...KEYCLOAK_PRODUCTION })).toThrow(
      /^(?!.*prod-secret-key).*AWS_ACCESS_KEY_ID/s
    );
  });

  it('production without AWS_SECRET_ACCESS_KEY throws and names the variable, not a value', () => {
    const { AWS_SECRET_ACCESS_KEY: _omitted, ...raw } = PRODUCTION_BASE;

    expect(() => parseEnv({ ...raw, ...KEYCLOAK_PRODUCTION })).toThrow(
      /^(?!.*prod-key-id).*AWS_SECRET_ACCESS_KEY/s
    );
  });

  it('AWS_ENDPOINT_URL must be a URL', () => {
    expect(() => parseEnv({ AWS_ENDPOINT_URL: 'not a url' })).toThrow(
      /^(?!.*not a url).*AWS_ENDPOINT_URL/s
    );
  });

  it('uses the local mail sink outside production', () => {
    const env = parseEnv({ NODE_ENV: 'test' });
    expect(env.MAIL_PROVIDER).toBe('smtp');
    expect(env.SMTP_URL).toBe(LOCAL_SMTP_URL);
  });

  it('defaults MAIL_PROVIDER to ses in production and does not require SMTP_URL', () => {
    const { SMTP_URL: _omitted, ...raw } = PRODUCTION_BASE;
    const env = parseEnv({ ...raw, ...KEYCLOAK_PRODUCTION });

    expect(env.MAIL_PROVIDER).toBe('ses');
    expect(env.SMTP_URL).toBeUndefined();
  });

  it('production with MAIL_PROVIDER=smtp without SMTP_URL throws and names the variable', () => {
    const { SMTP_URL: _omitted, ...raw } = PRODUCTION_BASE;

    expect(() => parseEnv({ ...raw, ...KEYCLOAK_PRODUCTION, MAIL_PROVIDER: 'smtp' })).toThrow(
      /SMTP_URL/
    );
  });

  it('MAIL_PROVIDER rejects unknown transports, SMTP_URL must be a URL and MAIL_FROM an address', () => {
    expect(() => parseEnv({ MAIL_PROVIDER: 'sendgrid' })).toThrow(/MAIL_PROVIDER/);
    expect(() => parseEnv({ SMTP_URL: 'not a url' })).toThrow(/SMTP_URL/);
    expect(() => parseEnv({ MAIL_FROM: 'nobody' })).toThrow(/MAIL_FROM/);
  });

  it('has tracing off by default and switches it on with the string true', () => {
    expect(parseEnv({}).TRACING_ENABLED).toBe(false);
    expect(parseEnv({ TRACING_ENABLED: 'true' }).TRACING_ENABLED).toBe(true);
    expect(parseEnv({ TRACING_ENABLED: 'false' }).TRACING_ENABLED).toBe(false);
  });

  it('has metrics off by default on port 9464, and names METRICS_PORT outside the port range', () => {
    expect(parseEnv({ METRICS_ENABLED: 'true', METRICS_PORT: '9100' })).toMatchObject({
      METRICS_ENABLED: true,
      METRICS_PORT: 9100,
    });
    expect(() => parseEnv({ METRICS_PORT: '0' })).toThrow(/METRICS_PORT/);
    expect(() => parseEnv({ METRICS_PORT: '65536' })).toThrow(/METRICS_PORT/);
  });

  it('listens for metrics on loopback unless METRICS_HOST says otherwise, and names a bad host', () => {
    expect(parseEnv({}).METRICS_HOST).toBe('127.0.0.1');
    expect(parseEnv({ METRICS_HOST: '0.0.0.0' }).METRICS_HOST).toBe('0.0.0.0');
    expect(() => parseEnv({ METRICS_HOST: 'localhost' })).toThrow(/METRICS_HOST/);
  });

  it('names TRACING_OTLP_ENDPOINT when it is not a URL, and strips trailing slashes', () => {
    expect(() => parseEnv({ TRACING_OTLP_ENDPOINT: 'not a url' })).toThrow(/TRACING_OTLP_ENDPOINT/);
    expect(parseEnv({ TRACING_OTLP_ENDPOINT: 'http://tempo:4318/' }).TRACING_OTLP_ENDPOINT).toBe(
      'http://tempo:4318'
    );
  });

  it('has no GRAFANA_URL by default and names it when it is not a URL', () => {
    expect(parseEnv({}).GRAFANA_URL).toBeUndefined();
    expect(parseEnv({ GRAFANA_URL: 'http://localhost:3000' }).GRAFANA_URL).toBe(
      'http://localhost:3000'
    );
    expect(() => parseEnv({ GRAFANA_URL: 'not a url' })).toThrow(/GRAFANA_URL/);
  });

  it('disables demo login and unsafe strategies by default in production unless opted in', () => {
    const prod = parseEnv({ ...PRODUCTION_BASE, ...KEYCLOAK_PRODUCTION });
    expect(prod.DEMO_LOGIN_ENABLED).toBe(false);
    expect(prod.UNSAFE_STRATEGIES_ENABLED).toBe(false);

    const optedIn = parseEnv({
      ...PRODUCTION_BASE,
      ...KEYCLOAK_PRODUCTION,
      DEMO_LOGIN_ENABLED: 'true',
      UNSAFE_STRATEGIES_ENABLED: 'true',
    });
    expect(optedIn.DEMO_LOGIN_ENABLED).toBe(true);
    expect(optedIn.UNSAFE_STRATEGIES_ENABLED).toBe(true);
  });

  it('strips trailing slashes from S3_PRESIGN_BASE_URL and leaves it undefined by default', () => {
    expect(parseEnv({}).S3_PRESIGN_BASE_URL).toBeUndefined();
    expect(parseEnv({ S3_PRESIGN_BASE_URL: '/storage/' }).S3_PRESIGN_BASE_URL).toBe('/storage');
    expect(parseEnv({ S3_PRESIGN_BASE_URL: 'https://cdn.example.com/' }).S3_PRESIGN_BASE_URL).toBe(
      'https://cdn.example.com'
    );
  });

  it('requires WAITING_ROOM_SIGNING_SECRET of at least 32 characters in production without printing it', () => {
    const { WAITING_ROOM_SIGNING_SECRET: _omitted, ...raw } = PRODUCTION_BASE;
    expect(() => parseEnv({ ...raw, ...KEYCLOAK_PRODUCTION })).toThrow(
      /WAITING_ROOM_SIGNING_SECRET/
    );
    expect(() =>
      parseEnv({
        ...raw,
        ...KEYCLOAK_PRODUCTION,
        WAITING_ROOM_SIGNING_SECRET: 'too-short-secret-value',
      })
    ).toThrow(/^(?!.*too-short-secret-value).*WAITING_ROOM_SIGNING_SECRET/s);
  });
});
