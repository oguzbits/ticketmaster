import { describe, expect, it } from 'vitest';

import { loadEnv } from '../config/config.module.js';
import { LOCAL_MAILPIT_ORIGIN } from './mock-server.js';

// The reserved TLD `.invalid` never resolves: without the guard this fails with a DNS error, with
// the guard MSW rejects the request first. The message tells the two apart.
const UNMOCKED_URL = 'https://unmocked.invalid/';

async function outcome(url: string): Promise<string> {
  return fetch(url).then(
    () => 'resolved',
    (error: Error) => `${error.message} ${String(error.cause ?? '')}`
  );
}

describe('network guard (vitest.setup.ts)', () => {
  it('rejects a request that no handler covers', async () => {
    expect(await outcome(UNMOCKED_URL)).toMatch(/\[MSW\]/);
  });

  it('rejects the local AWS emulator and Mailpit in offline specs', async () => {
    const { AWS_ENDPOINT_URL } = loadEnv();
    if (AWS_ENDPOINT_URL !== undefined) {
      expect(await outcome(`${AWS_ENDPOINT_URL}/`)).toMatch(/\[MSW\]/);
    }
    expect(await outcome(`${LOCAL_MAILPIT_ORIGIN}/api/v1/messages`)).toMatch(/\[MSW\]/);
  });
});
