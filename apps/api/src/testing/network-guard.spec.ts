import { describe, expect, it } from 'vitest';

// The reserved TLD `.invalid` never resolves: without the guard this fails with a DNS error, with
// the guard MSW rejects the request first. The message tells the two apart.
const UNMOCKED_URL = 'https://unmocked.invalid/';

describe('network guard (vitest.setup.ts)', () => {
  it('rejects a request that no handler covers', async () => {
    const outcome = await fetch(UNMOCKED_URL).then(
      () => 'resolved',
      (error: Error) => `${error.message} ${String(error.cause ?? '')}`
    );

    expect(outcome).toMatch(/\[MSW\]/);
  });
});
