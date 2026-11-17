import { describe, expect, it } from 'vitest';

import { EnvSchema } from '../../apps/api/src/config/env.ts';
import { envStatus } from './env-status.mjs';

describe('envStatus', () => {
  it('formats required, optional, defaulted and transformed-default fields', () => {
    expect(envStatus(EnvSchema.shape.DATABASE_URL)).toBe('required');
    expect(envStatus(EnvSchema.shape.CORS_ORIGIN)).toBe('optional');
    expect(envStatus(EnvSchema.shape.PORT)).toBe('default `3000`');
    expect(envStatus(EnvSchema.shape.TRACING_OTLP_ENDPOINT)).toBe(
      'default `http://localhost:4318`'
    );
  });
});
