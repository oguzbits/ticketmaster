import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, SIMULATION_STATUS, type SimulationStatus } from '@app/shared';
import { HttpStatus, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { events, simulationRuns } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import {
  MAX_ACTIVE_RUNS,
  SIMULATION_RUN_TIMEOUT_MS,
  SimulationsService,
} from './simulations.service.js';
import { clearSimulationRuns, lockSimulationRuns } from './testing/exclusive-runs.js';

// The cap counts the runs of the whole table that started within its timeout up to now: this file
// holds the spec lock and clears every run from WINDOW_START on before each test.
const NOW = new Date(SPEC_NOW.getTime() + 24 * 60 * 60 * 1000);
const WINDOW_START = new Date(NOW.getTime() - 60 * 60 * 1000);
const SPEC_LOCK_TIMEOUT_MS = 300_000;
const STRATEGY = BOOKING_STRATEGY.PESSIMISTIC;
const REQUEST = { buyers: 10, seats: 5, strategy: STRATEGY };

describe('SimulationsService.start', () => {
  const database = openTestDatabase();
  const { db } = database;
  const streamKey = `simulations:spec:${randomUUID()}`;
  let redis: Awaited<ReturnType<typeof openTestRedis>>;
  let service: SimulationsService;
  let unlock: () => Promise<void>;

  beforeAll(async () => {
    unlock = await lockSimulationRuns(db);
    redis = await openTestRedis();
    service = new SimulationsService(db, redis, { now: () => NOW });
    service.streamKey = streamKey;
    // A venue to host the sandbox events (a fresh test database has none).
    await createTestEvent(db, { strategy: STRATEGY, seats: 0 });
  }, SPEC_LOCK_TIMEOUT_MS);
  beforeEach(async () => {
    await clearSimulationRuns(db, WINDOW_START);
  });
  afterAll(async () => {
    await unlock();
    await redis.del(streamKey);
    await redis.quit();
    await database.close();
  });

  /** A run row that was started `agoMs` before NOW, on a throw-away event. */
  async function seedRun(status: SimulationStatus, agoMs: number): Promise<void> {
    const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 0 });
    await db.insert(simulationRuns).values({
      eventId,
      strategy: STRATEGY,
      buyers: 1,
      seats: 1,
      status,
      startedBy: randomUUID(),
      startedAt: new Date(NOW.getTime() - agoMs),
    });
  }

  async function startFor(adminId: string) {
    return service.start(REQUEST, adminId);
  }

  /** What `start` must not leave behind when it refuses: events, run rows and queue entries. */
  async function footprint(adminId: string) {
    return {
      events: await db.select().from(events).where(eq(events.ownerId, adminId)),
      runs: await db.select().from(simulationRuns).where(eq(simulationRuns.startedBy, adminId)),
      entries: await redis.xLen(streamKey),
    };
  }

  it('refuses the third active run with 429 and writes nothing', async () => {
    await seedRun(SIMULATION_STATUS.QUEUED, 1000);
    await seedRun(SIMULATION_STATUS.RUNNING, 2000);
    const adminId = randomUUID();
    const before = await footprint(adminId);

    await expect(startFor(adminId)).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });

    expect(await footprint(adminId)).toEqual(before);
  });

  it('does not count a run that started before the timeout', async () => {
    await seedRun(SIMULATION_STATUS.RUNNING, SIMULATION_RUN_TIMEOUT_MS + 1);
    await seedRun(SIMULATION_STATUS.RUNNING, SIMULATION_RUN_TIMEOUT_MS + 2);

    const run = await startFor(randomUUID());

    expect(run.status).toBe(SIMULATION_STATUS.QUEUED);
  });

  it('does not count finished or failed runs', async () => {
    await seedRun(SIMULATION_STATUS.FINISHED, 1000);
    await seedRun(SIMULATION_STATUS.FAILED, 1000);

    const run = await startFor(randomUUID());

    expect(run.status).toBe(SIMULATION_STATUS.QUEUED);
  });

  it(`lets parallel starts create exactly ${MAX_ACTIVE_RUNS} runs`, async () => {
    const adminId = randomUUID();
    const before = await footprint(adminId);

    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => startFor(adminId)));

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(MAX_ACTIVE_RUNS);
    const { runs, events: created, entries } = await footprint(adminId);
    expect([runs.length, created.length, entries - before.entries]).toEqual([
      MAX_ACTIVE_RUNS,
      MAX_ACTIVE_RUNS,
      MAX_ACTIVE_RUNS,
    ]);
  });

  it('counts runs that started after the clock reading of a request that lost the lock race', async () => {
    // A request reads the clock before it gets the lock, so its reading can be older than the runs
    // that committed meanwhile: the clock goes back by a minute with every reading here.
    let reading = NOW.getTime();
    const lagging = new SimulationsService(db, redis, {
      now: () => new Date((reading -= 60_000)),
    });
    lagging.streamKey = streamKey;

    await lagging.start(REQUEST, randomUUID());
    await lagging.start(REQUEST, randomUUID());

    await expect(lagging.start(REQUEST, randomUUID())).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('marks the run FAILED and rethrows when the queue entry cannot be written', async () => {
    const adminId = randomUUID();
    const failing = new SimulationsService(
      db,
      {
        xAdd: () => Promise.reject(new Error('redis down')),
      },
      { now: () => NOW }
    );

    await expect(failing.start(REQUEST, adminId)).rejects.toThrow('redis down');

    const runs = await db
      .select()
      .from(simulationRuns)
      .where(eq(simulationRuns.startedBy, adminId));
    expect(runs.map(({ status }) => status)).toEqual([SIMULATION_STATUS.FAILED]);
  });

  it('rethrows the queue error, not the one of a failing fail(), and logs the second', async () => {
    class FailsToFail extends SimulationsService {
      override fail(): Promise<void> {
        return Promise.reject(new Error('database down'));
      }
    }
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new FailsToFail(
      db,
      { xAdd: () => Promise.reject(new Error('redis down')) },
      {
        now: () => NOW,
      }
    );

    await expect(service.start(REQUEST, randomUUID())).rejects.toThrow('redis down');

    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
