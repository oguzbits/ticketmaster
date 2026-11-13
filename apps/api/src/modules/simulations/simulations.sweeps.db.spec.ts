import { randomUUID } from 'node:crypto';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  SIMULATION_STATUS,
  type SimulationStatus,
  TRANSITION_REASON,
} from '@app/shared';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bookings,
  bookingTransitions,
  events,
  seats,
  simulationRuns,
} from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { EMPTY_METRICS } from './simulation-progress.js';
import {
  SIMULATION_RETENTION_SECONDS,
  SIMULATION_RUN_TIMEOUT_MS,
  SimulationsService,
} from './simulations.service.js';

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

  /** A run that started `agoMs` before NOW; returns its ID. `onEvent` adds a run to an event. */
  async function seedRun(
    status: SimulationStatus,
    agoMs: number,
    finishedAgoMs: number | null = null,
    onEvent?: string
  ): Promise<string> {
    const eventId =
      onEvent ?? (await createTestEvent(db, { strategy: STRATEGY, seats: 0 })).eventId;
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

  describe('finish', () => {
    const METRICS = { ...EMPTY_METRICS, buyersDone: 1 };

    it('stores the result of a RUNNING run and reports the change', async () => {
      const running = await seedRun(SIMULATION_STATUS.RUNNING, 1000);

      expect(await service.finish(running, METRICS)).toBe(true);

      expect(await service.find(running)).toMatchObject({
        status: SIMULATION_STATUS.FINISHED,
        metrics: METRICS,
        finishedAt: NOW.toISOString(),
      });
    });

    it('leaves a run the reaper already failed FAILED and reports no change', async () => {
      const failed = await seedRun(SIMULATION_STATUS.FAILED, 1000, 500);
      const before = await service.find(failed);

      expect(await service.finish(failed, METRICS)).toBe(false);

      expect(await service.find(failed)).toEqual(before);
    });
  });

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

  describe('deleteFinished', () => {
    const RETENTION_MS = SIMULATION_RETENTION_SECONDS * 1000;
    const OLD = RETENTION_MS + 1;
    const LIMIT = 10;

    const eventOf = async (runId: string) => (await service.find(runId)).eventId;
    const eventExists = async (eventId: string) =>
      (await db.select({ id: events.id }).from(events).where(eq(events.id, eventId))).length === 1;

    it('removes the event of a run that finished before the retention, with everything under it', async () => {
      const { eventId, seatIds } = await createTestEvent(db, { strategy: STRATEGY, seats: 2 });
      const [booking] = await db
        .insert(bookings)
        .values({
          eventId,
          seatId: seatIds[0] ?? '',
          userId: randomUUID(),
          strategy: STRATEGY,
          status: BOOKING_STATUS.HELD,
          holdExpiresAt: NOW,
        })
        .returning({ id: bookings.id });
      if (booking === undefined) throw new Error('booking insert returned no row');
      await db.insert(bookingTransitions).values({
        bookingId: booking.id,
        toStatus: BOOKING_STATUS.HELD,
        reason: TRANSITION_REASON.HOLD,
      });
      const runId = await seedRun(SIMULATION_STATUS.FINISHED, 2 * OLD, OLD, eventId);

      expect(await service.deleteFinished(NOW, LIMIT)).toBe(1);

      const left = {
        event: await eventExists(eventId),
        seats: await db.select().from(seats).where(eq(seats.eventId, eventId)),
        bookings: await db.select().from(bookings).where(eq(bookings.eventId, eventId)),
        transitions: await db
          .select()
          .from(bookingTransitions)
          .where(eq(bookingTransitions.bookingId, booking.id)),
        runs: await db.select().from(simulationRuns).where(eq(simulationRuns.id, runId)),
      };
      expect(left).toEqual({ event: false, seats: [], bookings: [], transitions: [], runs: [] });
    });

    it('removes a FAILED run past the retention as well', async () => {
      const runId = await seedRun(SIMULATION_STATUS.FAILED, 2 * OLD, OLD);
      const eventId = await eventOf(runId);

      await service.deleteFinished(NOW, LIMIT);

      expect(await eventExists(eventId)).toBe(false);
    });

    it('keeps a run that finished exactly at the retention or later', async () => {
      const edge = await seedRun(SIMULATION_STATUS.FINISHED, 2 * OLD, RETENTION_MS);
      const young = await seedRun(SIMULATION_STATUS.FAILED, 2 * OLD, 1000);

      expect(await service.deleteFinished(NOW, LIMIT)).toBe(0);

      expect([await eventOf(edge), await eventOf(young)].length).toBe(2);
    });

    it('never deletes the event of an active run, whatever its end time says', async () => {
      const queued = await seedRun(SIMULATION_STATUS.QUEUED, 2 * OLD);
      const running = await seedRun(SIMULATION_STATUS.RUNNING, 2 * OLD, OLD);

      expect(await service.deleteFinished(NOW, LIMIT)).toBe(0);

      expect([await eventOf(queued), await eventOf(running)].length).toBe(2);
    });

    it('keeps an event that still has an active run next to an old finished one', async () => {
      const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 0 });
      await seedRun(SIMULATION_STATUS.FINISHED, 2 * OLD, OLD, eventId);
      await seedRun(SIMULATION_STATUS.RUNNING, 1000, null, eventId);

      expect(await service.deleteFinished(NOW, LIMIT)).toBe(0);

      expect(await eventExists(eventId)).toBe(true);
    });

    it('deletes at most the batch limit per call and the rest on the next one', async () => {
      const runs = await Promise.all(
        [3, 2, 1].map((n) => seedRun(SIMULATION_STATUS.FINISHED, 4 * OLD, n * OLD))
      );
      const eventIds = await Promise.all(runs.map(eventOf));
      const remaining = async () =>
        (await db.select({ id: events.id }).from(events).where(inArray(events.id, eventIds)))
          .length;

      expect(await service.deleteFinished(NOW, 2)).toBe(2);
      expect(await remaining()).toBe(1);

      expect(await service.deleteFinished(NOW, 2)).toBe(1);
      expect(await remaining()).toBe(0);
    });
  });
});
