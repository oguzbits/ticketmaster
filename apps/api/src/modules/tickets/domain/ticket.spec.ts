import { describe, expect, it } from 'vitest';

import { ticketObjectKey } from './ticket.js';

describe('ticketObjectKey', () => {
  // Stored objects are found by this key, so changing it orphans every ticket already written.
  it('names the PDF of a booking under tickets/', () => {
    expect(ticketObjectKey('b-1')).toBe('tickets/b-1.pdf');
  });
});
