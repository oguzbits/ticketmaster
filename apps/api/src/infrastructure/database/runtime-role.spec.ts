import { describe, expect, it } from 'vitest';

import { runtimeRolePassword } from './runtime-role.js';

describe('runtimeRolePassword', () => {
  it('returns the password as the client sends it, not percent-encoded', () => {
    expect(runtimeRolePassword('postgres://app_runtime:p%40ss%2Fw%3Ard@localhost:5432/app')).toBe(
      'p@ss/w:rd'
    );
  });
});
