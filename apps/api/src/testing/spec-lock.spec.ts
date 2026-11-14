import { describe, expect, it } from 'vitest';

import { lockSpecs } from './spec-lock.js';

/** A database whose lock transaction runs its body, then fails: the connection that held the lock died. */
const dyingDatabase: Parameters<typeof lockSpecs>[0] = {
  transaction: async (run) => {
    await run({ execute: async () => [] });
    throw new Error('connection lost');
  },
};

describe('lockSpecs', () => {
  it('the release function reports a lock transaction that failed after the lock was taken', async () => {
    const unlock = await lockSpecs(dyingDatabase, 'spec-lock-spec');

    await expect(unlock()).rejects.toThrow('connection lost');
  });
});
