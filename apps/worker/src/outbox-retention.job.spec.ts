import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OUTBOX_RETENTION_BATCH, OutboxRetentionJob } from './outbox-retention.job.js';

const TICK = new Date('2026-01-01T12:00:00.000Z');

describe('OutboxRetentionJob', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("passes the injected clock's time and the batch size to both deletes", async () => {
    const calls: [string, Date, number][] = [];
    const job = new OutboxRetentionJob(
      {
        deletePublished: (at, limit) => {
          calls.push(['published', at, limit]);
          return Promise.resolve(3);
        },
        deleteProcessed: (at, limit) => {
          calls.push(['processed', at, limit]);
          return Promise.resolve(2);
        },
      },
      { now: () => TICK }
    );

    await job.run();

    expect(calls).toEqual([
      ['published', TICK, OUTBOX_RETENTION_BATCH],
      ['processed', TICK, OUTBOX_RETENTION_BATCH],
    ]);
  });

  it('logs a failing tick and resolves, so the next tick still runs', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const job = new OutboxRetentionJob(
      {
        deletePublished: () => Promise.resolve(0),
        deleteProcessed: () => Promise.reject(new Error('database down')),
      },
      { now: () => TICK }
    );

    await expect(job.run()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('outbox retention failed'));
  });
});
