import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SIMULATION_RETENTION_BATCH, SimulationRetentionJob } from './simulation-retention.job.js';

const TICK = new Date('2026-01-01T12:00:00.000Z');

describe('SimulationRetentionJob', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("passes the injected clock's time and the batch size to deleteFinished", async () => {
    const calls: [Date, number][] = [];
    const job = new SimulationRetentionJob(
      {
        deleteFinished: (at, limit) => {
          calls.push([at, limit]);
          return Promise.resolve(3);
        },
      },
      { now: () => TICK }
    );

    await job.run();

    expect(calls).toEqual([[TICK, SIMULATION_RETENTION_BATCH]]);
  });

  it('logs a failing tick and resolves, so the next tick still runs', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const job = new SimulationRetentionJob(
      { deleteFinished: () => Promise.reject(new Error('database down')) },
      { now: () => TICK }
    );

    await expect(job.run()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('simulation retention failed'));
  });
});
