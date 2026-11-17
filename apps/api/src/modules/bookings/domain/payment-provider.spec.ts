import { describe, expect, it } from 'vitest';

import { refundKey } from './payment-provider.js';

describe('refundKey', () => {
  it('derives a key that differs from the charge key and is stable for it', () => {
    expect(refundKey('charge-1')).toBe('refund:charge-1');
  });
});
