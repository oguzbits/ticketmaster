import { describe, expect, it } from 'vitest';

import { demoIdentity } from './demo-user.js';

describe('demoIdentity', () => {
  it('has everything Keycloak needs for a password grant, on a domain that cannot receive mail', () => {
    const identity = demoIdentity('abc123');

    expect(identity.username).toBe('demo-abc123');
    expect(identity.email).toMatch(/^[^@]+@[^@]+\.invalid$/);
    expect(identity.firstName).not.toBe('');
    expect(identity.lastName).not.toBe('');
  });
});
