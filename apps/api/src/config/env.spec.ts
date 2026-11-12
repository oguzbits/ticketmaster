import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

const LOCAL_DATABASE_URL = 'postgres://app:app@localhost:54330/app';
const LOCAL_REDIS_URL = 'redis://localhost:63790';

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

  it('production without DATABASE_URL throws and names the variable, not a value', () => {
    const raw = { NODE_ENV: 'production', REDIS_URL: 'redis://secret-host:6379' };

    expect(() => parseEnv(raw)).toThrow(/^(?!.*secret-host).*DATABASE_URL/s);
  });

  it('production without REDIS_URL throws and names the variable', () => {
    const raw = { NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db:5432/app' };

    expect(() => parseEnv(raw)).toThrow(/REDIS_URL/);
  });

  it('production takes both URLs from the environment', () => {
    const raw = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@db:5432/app',
      REDIS_URL: 'redis://cache:6379',
    };

    expect(parseEnv(raw)).toMatchObject({
      DATABASE_URL: raw.DATABASE_URL,
      REDIS_URL: raw.REDIS_URL,
    });
  });

  it('PAYMENT_FAILURE_RATE above 1 is rejected', () => {
    expect(() => parseEnv({ PAYMENT_FAILURE_RATE: '1.5' })).toThrow(/PAYMENT_FAILURE_RATE/);
  });

  it('HOLD_TTL_SECONDS must be a positive integer', () => {
    expect(() => parseEnv({ HOLD_TTL_SECONDS: '0' })).toThrow(/HOLD_TTL_SECONDS/);
  });
});
