import { describe, expect, it } from 'vitest';

import { seatChannel } from './seat-change.js';

describe('seatChannel', () => {
  // Every API replica publishes and subscribes on this name; a replica on another name goes deaf.
  it('is one channel per event', () => {
    expect(seatChannel('e-1')).toBe('seats:e-1');
    expect(seatChannel('e-2')).not.toBe(seatChannel('e-1'));
  });
});
