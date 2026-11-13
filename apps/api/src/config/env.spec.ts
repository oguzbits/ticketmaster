import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

const LOCAL_DATABASE_URL = 'postgres://app:app@localhost:54330/app';
const LOCAL_REDIS_URL = 'redis://localhost:63790';
const LOCAL_KEYCLOAK_URL = 'http://localhost:8081';
const LOCAL_KEYCLOAK_SECRET = 'local-demo-client-secret';
const LOCAL_AWS_ENDPOINT_URL = 'http://localhost:45660';
const LOCAL_AWS_CREDENTIAL = 'test';

const PRODUCTION_BASE = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db:5432/app',
  REDIS_URL: 'redis://cache:6379',
  AWS_ACCESS_KEY_ID: 'prod-key-id',
  AWS_SECRET_ACCESS_KEY: 'prod-secret-key',
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
      REDIS_URL: LOCAL_REDIS_URL,
      HOLD_TTL_SECONDS: 600,
      PAYMENT_FAILURE_RATE: 0.1,
      KEYCLOAK_URL: LOCAL_KEYCLOAK_URL,
      KEYCLOAK_REALM: 'ticketmaster',
      KEYCLOAK_DEMO_CLIENT_ID: 'api-demo',
      KEYCLOAK_DEMO_CLIENT_SECRET: LOCAL_KEYCLOAK_SECRET,
      DEMO_USER_TTL_SECONDS: 3600,
      AWS_ENDPOINT_URL: LOCAL_AWS_ENDPOINT_URL,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: LOCAL_AWS_CREDENTIAL,
      AWS_SECRET_ACCESS_KEY: LOCAL_AWS_CREDENTIAL,
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
});
