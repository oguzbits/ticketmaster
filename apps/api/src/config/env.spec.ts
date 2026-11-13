import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

const LOCAL_DATABASE_URL = 'postgres://app:app@localhost:54330/app';
const LOCAL_REDIS_URL = 'redis://localhost:63790';
const LOCAL_KEYCLOAK_URL = 'http://localhost:8081';
const LOCAL_KEYCLOAK_SECRET = 'local-demo-client-secret';

const PRODUCTION_BASE = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db:5432/app',
  REDIS_URL: 'redis://cache:6379',
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
});
