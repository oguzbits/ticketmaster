import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { type Database, DB } from '@app/api/database';
import { REDIS, type Redis } from '@app/api/redis';
import {
  SIMULATION_RUN_TIMEOUT_MS,
  simulationProgressKey,
  SimulationsService,
} from '@app/api/simulations';
import { ensureVenue } from '@app/api/simulations/testing';
import {
  BOOKING_STRATEGY,
  SIMULATION_CONSUMER_GROUP,
  SIMULATION_STATUS,
  SimulationProgressSchema,
} from '@app/shared';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SimulationReaperJob } from './simulation-reaper.job.js';
import { WorkerModule } from './worker.module.js';

// An era of its own: the job sweeps the whole table, so it must see only this file's runs.
const NOW = new Date('1990-01-04T12:00:00.000Z');
const REQUEST = { buyers: 1, seats: 1, strategy: BOOKING_STRATEGY.PESSIMISTIC };
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
    await ensureVenue(moduleRef.get<Database>(DB, { strict: false }));
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

  it('fails a run that is stale at the job clock and ends its progress: row and key say FAILED', async () => {
    const simulations = moduleRef.get(SimulationsService, { strict: false });
    // A run that started 20 minutes before the job's clock, written through the real start path.
    const starter = new SimulationsService(moduleRef.get<Database>(DB, { strict: false }), redis, {
      now: () => new Date(NOW.getTime() - 2 * SIMULATION_RUN_TIMEOUT_MS),
    });
    starter.streamKey = streamKey;
    const run = await starter.start(REQUEST, randomUUID());
    try {
      await job.run();

      expect((await simulations.find(run.id)).status).toBe(SIMULATION_STATUS.FAILED);
      const raw = await redis.get(simulationProgressKey(run.id));
      expect(SimulationProgressSchema.parse(JSON.parse(raw ?? 'null')).status).toBe(
        SIMULATION_STATUS.FAILED
      );
    } finally {
      await starter.discard(run.eventId);
      await redis.del(simulationProgressKey(run.id));
    }
  });
});
