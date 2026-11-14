import { AUDIT_LOG_LIMITS } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { requestIdOf } from './request-id.decorator.js';

describe('requestIdOf', () => {
  it('returns the ID the HTTP logger gave the request', () => {
    expect(requestIdOf({ id: 'abc' })).toBe('abc');
  });

  it('cuts an ID longer than the audit column to its limit', () => {
    const long = 'y'.repeat(AUDIT_LOG_LIMITS.REQUEST_ID_MAX + 1);

    expect(requestIdOf({ id: long })).toBe(long.slice(0, AUDIT_LOG_LIMITS.REQUEST_ID_MAX));
  });

  it('keeps an ID of exactly the limit', () => {
    const exact = 'z'.repeat(AUDIT_LOG_LIMITS.REQUEST_ID_MAX);

    expect(requestIdOf({ id: exact })).toBe(exact);
  });

  it('throws when the request has no ID, so a missing logger is not stored as an empty value', () => {
    expect(() => requestIdOf({})).toThrow();
    expect(() => requestIdOf({ id: '' })).toThrow();
  });
});
