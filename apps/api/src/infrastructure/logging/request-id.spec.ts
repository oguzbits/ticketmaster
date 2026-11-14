import type { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import { requestId } from './request-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/;

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

  it.each([
    ['an email address', 'a@b.de'],
    ['a space', 'trace 42'],
    ['a value of 129 characters', 'x'.repeat(129)],
  ])('replaces a caller id with %s by a UUID', (_name, value) => {
    expect(requestId(requestWith({ 'x-request-id': value }))).toMatch(UUID);
  });

  it('keeps a caller id of 128 allowed characters', () => {
    const exact = 'a.B_c-1'.repeat(18).slice(0, 128);

    expect(requestId(requestWith({ 'x-request-id': exact }))).toBe(exact);
  });

  it('generates a fresh id for every request', () => {
    expect(requestId(requestWith({}))).not.toBe(requestId(requestWith({})));
  });
});
