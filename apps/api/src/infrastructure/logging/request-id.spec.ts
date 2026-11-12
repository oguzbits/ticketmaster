import type { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import { requestId } from './request-id.js';

function requestWith(headers: IncomingMessage['headers']): IncomingMessage {
  // SAFETY: requestId reads only `headers`, so a bare headers object is a sufficient stand-in.
  return { headers } as IncomingMessage;
}

describe('requestId', () => {
  it('takes the x-request-id header of the caller', () => {
    expect(requestId(requestWith({ 'x-request-id': 'trace-42' }))).toBe('trace-42');
  });

  it('generates a UUID when the header is missing', () => {
    expect(requestId(requestWith({}))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('generates a fresh id for every request', () => {
    expect(requestId(requestWith({}))).not.toBe(requestId(requestWith({})));
  });
});
