import { EMPTY_METRICS, simulationProgressKey } from '@app/api/simulations';
import { SIMULATION_STATUS, SimulationProgressSchema } from '@app/shared';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SimulationReaperJob } from './simulation-reaper.job.js';

const TICK = new Date('2026-01-01T12:00:00.000Z');

type Writes = [key: string, value: string][];

/** The job over fakes: the service reports the reaped runs, `set` records or fails per key. */
function jobWith(
  failStale: (at: Date) => Promise<string[]>,
  set: (key: string, value: string) => Promise<string | null>
): SimulationReaperJob {
  return new SimulationReaperJob(
    { failStale },
    { set, xPendingRange: () => Promise.resolve([]), xAck: () => Promise.resolve(0) },
    { now: () => TICK }
  );
}

describe('SimulationReaperJob', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('marks the progress key of every reaped run FAILED, so open streams end', async () => {
    const writes: Writes = [];
    const job = jobWith(
      (at) => {
        expect(at).toEqual(TICK);
        return Promise.resolve(['run-1', 'run-2']);
      },
      (key, value) => {
        writes.push([key, value]);
        return Promise.resolve('OK');
      }
    );

    await job.run();

    expect(writes.map(([key]) => key)).toEqual([
      simulationProgressKey('run-1'),
      simulationProgressKey('run-2'),
    ]);
    for (const [, value] of writes) {
      expect(SimulationProgressSchema.parse(JSON.parse(value))).toEqual({
        status: SIMULATION_STATUS.FAILED,
        metrics: EMPTY_METRICS,
      });
    }
  });

  it('logs a failing tick and resolves, so the next tick still runs', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const job = jobWith(
      () => Promise.reject(new Error('database down')),
      () => Promise.resolve('OK')
    );

    await expect(job.run()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('simulation reaper'));
  });

  it('keeps going when the key of one run cannot be written, and names that run', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const written: string[] = [];
    const job = jobWith(
      () => Promise.resolve(['run-1', 'run-2']),
      (key) => {
        if (key === simulationProgressKey('run-1')) return Promise.reject(new Error('redis down'));
        written.push(key);
        return Promise.resolve('OK');
      }
    );

    await job.run();

    expect(written).toEqual([simulationProgressKey('run-2')]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('run-1'));
  });
});
