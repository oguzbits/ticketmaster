import { describe, expect, it } from 'vitest';

import { PRESIGNED_TICKET_TTL_SECONDS, ticketFilename, ticketObjectKey } from './ticket.js';

describe('ticket domain helpers', () => {
  // Stored objects are found by this key, so changing it orphans every ticket already written.
  it('names the PDF of a booking under tickets/', () => {
    expect(ticketObjectKey('b-1')).toBe('tickets/b-1.pdf');
  });

  it('builds the attachment filename and pins the presign TTL', () => {
    expect(ticketFilename('b-1')).toBe('ticket-b-1.pdf');
    expect(PRESIGNED_TICKET_TTL_SECONDS).toBe(60);
  });
});
