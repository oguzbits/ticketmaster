import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, SIMULATION_STATUS, type SimulationStatus } from '@app/shared';
import { and, gte, lt } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { simulationRuns } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { SIMULATION_RUN_TIMEOUT_MS, SimulationsService } from './simulations.service.js';

// The sweeps look at the whole table. This file runs on a clock far in the past, so it sees only
// its own rows: the rows of other files (real time, or the year 2200) are in its future and are
// neither stale nor old.
const NOW = new Date('2000-01-04T12:00:00.000Z');
const SPEC_START = new Date('2000-01-01T00:00:00.000Z');
const STRATEGY = BOOKING_STRATEGY.PESSIMISTIC;

describe('SimulationsService sweeps', () => {
  const database = openTestDatabase();
  const { db } = database;
  let service: SimulationsService;

  beforeAll(() => {
    // The sweeps never touch Redis.
    service = new SimulationsService(
      db,
      {
        set: () => Promise.reject(new Error('unused')),
        xAdd: () => Promise.reject(new Error('unused')),
      },
      { now: () => NOW }
    );
  });
  beforeEach(async () => {
    await db
      .delete(simulationRuns)
      .where(and(gte(simulationRuns.startedAt, SPEC_START), lt(simulationRuns.startedAt, NOW)));
  });
  afterAll(() => database.close());

  /** A run that started `agoMs` before NOW; returns its ID. */
  async function seedRun(
    status: SimulationStatus,
    agoMs: number,
    finishedAgoMs: number | null = null
  ): Promise<string> {
    const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 0 });
    const [row] = await db
      .insert(simulationRuns)
      .values({
        eventId,
        strategy: STRATEGY,
        buyers: 1,
        seats: 1,
        status,
        startedBy: randomUUID(),
        startedAt: new Date(NOW.getTime() - agoMs),
        finishedAt: finishedAgoMs === null ? null : new Date(NOW.getTime() - finishedAgoMs),
      })
      .returning({ id: simulationRuns.id });
    if (row === undefined) throw new Error('run insert returned no row');
    return row.id;
  }

  describe('failStale', () => {
    const STALE = SIMULATION_RUN_TIMEOUT_MS + 1;

    it('marks stale QUEUED and RUNNING runs FAILED with the end time and returns their IDs', async () => {
      const queued = await seedRun(SIMULATION_STATUS.QUEUED, STALE);
      const running = await seedRun(SIMULATION_STATUS.RUNNING, STALE);

      const reaped = await service.failStale(NOW);

      expect(reaped.toSorted()).toEqual([queued, running].toSorted());
      for (const id of [queued, running]) {
        expect(await service.find(id)).toMatchObject({
          status: SIMULATION_STATUS.FAILED,
          finishedAt: NOW.toISOString(),
        });
      }
    });

    it('leaves a run that is within the timeout, to the millisecond, active', async () => {
      const exactly = await seedRun(SIMULATION_STATUS.RUNNING, SIMULATION_RUN_TIMEOUT_MS);
      const fresh = await seedRun(SIMULATION_STATUS.QUEUED, 1000);

      expect(await service.failStale(NOW)).toEqual([]);

      expect((await service.find(exactly)).status).toBe(SIMULATION_STATUS.RUNNING);
      expect((await service.find(fresh)).status).toBe(SIMULATION_STATUS.QUEUED);
    });

    it('leaves FINISHED and FAILED runs as they are', async () => {
      const finished = await seedRun(SIMULATION_STATUS.FINISHED, STALE, STALE - 5);
      const failed = await seedRun(SIMULATION_STATUS.FAILED, STALE, STALE - 7);
      const before = [await service.find(finished), await service.find(failed)];

      expect(await service.failStale(NOW)).toEqual([]);

      expect([await service.find(finished), await service.find(failed)]).toEqual(before);
    });
  });
});
