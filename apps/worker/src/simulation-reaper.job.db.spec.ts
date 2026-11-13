import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { REDIS, type Redis } from '@app/api/redis';
import { SimulationsService } from '@app/api/simulations';
import { SIMULATION_CONSUMER_GROUP } from '@app/shared';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SimulationReaperJob } from './simulation-reaper.job.js';
import { WorkerModule } from './worker.module.js';

// The run sweep of these jobs looks at the whole table: a clock far in the past sees no run of
// another file, and the stream entries here are the point of this file.
const NOW = new Date('1990-01-04T12:00:00.000Z');
const IDLE_MS = 100;

describe('SimulationReaperJob with Redis', () => {
  let moduleRef: TestingModule;
  let redis: Redis;
  let job: SimulationReaperJob;
  let streamKey: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    redis = moduleRef.get<Redis>(REDIS, { strict: false });
    // The job is built by hand: a stream of its own, and a shorter idle time than the timeout.
    job = new SimulationReaperJob(moduleRef.get(SimulationsService, { strict: false }), redis, {
      now: () => NOW,
    });
    job.pendingIdleMs = IDLE_MS;
  });
  beforeEach(async () => {
    streamKey = `simulations:spec:${randomUUID()}`;
    job.streamKey = streamKey;
    await redis.xGroupCreate(streamKey, SIMULATION_CONSUMER_GROUP, '0', { MKSTREAM: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await redis.del(streamKey);
  });
  afterAll(() => moduleRef.close());

  const pending = async () => (await redis.xPending(streamKey, SIMULATION_CONSUMER_GROUP)).pending;

  /** An entry that a consumer of the group read and never acknowledged: a dead worker's. */
  async function readAndAbandon(): Promise<void> {
    await redis.xAdd(streamKey, '*', { runId: randomUUID() });
    await redis.xReadGroup(SIMULATION_CONSUMER_GROUP, 'dead-worker', { key: streamKey, id: '>' });
  }

  it('acknowledges a pending entry that has been idle longer than the limit', async () => {
    await readAndAbandon();
    expect(await pending()).toBe(1);
    await sleep(IDLE_MS * 2);

    await job.run();

    expect(await pending()).toBe(0);
  });

  it('leaves a recently delivered entry pending: its worker may still be running it', async () => {
    await readAndAbandon();
    job.pendingIdleMs = 60_000;

    await job.run();

    expect(await pending()).toBe(1);
    job.pendingIdleMs = IDLE_MS;
  });

  it('still acknowledges stale entries when the sweep of the runs fails', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const broken = new SimulationReaperJob(
      { failStale: () => Promise.reject(new Error('database down')) },
      redis,
      { now: () => NOW }
    );
    broken.streamKey = streamKey;
    broken.pendingIdleMs = IDLE_MS;
    await readAndAbandon();
    await sleep(IDLE_MS * 2);

    await broken.run();

    expect(await pending()).toBe(0);
  });
});
