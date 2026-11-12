import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

describe('parseEnv', () => {
  it('coerces values from strings and fills in defaults', () => {
    expect(parseEnv({ PORT: '8080' })).toEqual({ PORT: 8080 });
    expect(parseEnv({})).toEqual({ PORT: 3000 });
  });

  it('names the invalid variable but never prints its value', () => {
    expect(() => parseEnv({ PORT: 'secret-value' })).toThrow(/^(?!.*secret-value).*PORT/s);
  });
});
