import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, SIMULATION_STATUS, type SimulationStatus } from '@app/shared';
import { HttpStatus } from '@nestjs/common';
import { and, eq, gte, lte } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { events, simulationRuns } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import {
  MAX_ACTIVE_RUNS,
  SIMULATION_RUN_TIMEOUT_MS,
  SimulationsService,
} from './simulations.service.js';

// The cap counts the runs of the whole table inside a window around the clock, so this file owns a
// day of its own (the controller spec uses SPEC_NOW, the stream spec the day after).
const NOW = new Date(SPEC_NOW.getTime() + 24 * 60 * 60 * 1000);
const WINDOW_START = new Date(NOW.getTime() - 60 * 60 * 1000);
const WINDOW_END = new Date(NOW.getTime() + 60 * 60 * 1000);
const STRATEGY = BOOKING_STRATEGY.PESSIMISTIC;
const REQUEST = { buyers: 10, seats: 5, strategy: STRATEGY };

describe('SimulationsService.start', () => {
  const database = openTestDatabase();
  const { db } = database;
  const streamKey = `simulations:spec:${randomUUID()}`;
  let redis: Awaited<ReturnType<typeof openTestRedis>>;
  let service: SimulationsService;

  beforeAll(async () => {
    redis = await openTestRedis();
    service = new SimulationsService(db, redis, { now: () => NOW });
    service.streamKey = streamKey;
    // A venue to host the sandbox events (a fresh test database has none).
    await createTestEvent(db, { strategy: STRATEGY, seats: 0 });
  });
  beforeEach(async () => {
    await db
      .delete(simulationRuns)
      .where(
        and(gte(simulationRuns.startedAt, WINDOW_START), lte(simulationRuns.startedAt, WINDOW_END))
      );
  });
  afterAll(async () => {
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
});
