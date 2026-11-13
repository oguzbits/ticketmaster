import { randomUUID } from 'node:crypto';

import {
  BOOKING_STRATEGY,
  SIMULATION_STATUS,
  type SimulationMetrics,
  type SimulationProgress,
  type SimulationStatus,
} from '@app/shared';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { simulationRuns } from '../../infrastructure/database/schema.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import {
  EMPTY_METRICS,
  SIMULATION_PROGRESS_TTL_SECONDS,
  simulationProgressKey,
} from './simulation-progress.js';
import { SimulationStreamService } from './simulation-stream.service.js';
import { SimulationsService } from './simulations.service.js';

const POLL_MS = 20;
const METRICS: SimulationMetrics = { ...EMPTY_METRICS, attempts: 3, holds: 2, buyersDone: 3 };
const progress = (
  status: SimulationStatus,
  metrics: SimulationMetrics = METRICS
): SimulationProgress => ({ status, metrics });

describe('SimulationStreamService', () => {
  const database = openTestDatabase();
  const { db } = database;
  let redis: Redis;
  let service: SimulationStreamService;
  const open: Subscription[] = [];

  beforeAll(async () => {
    redis = await openTestRedis();
    service = new SimulationStreamService(
      redis,
      new SimulationsService(db, redis, { now: () => SPEC_NOW })
    );
    service.pollMs = POLL_MS;
  });
  afterEach(() => {
    for (const subscription of open.splice(0)) subscription.unsubscribe();
    service.maxStreams = 50;
    service.maxLifetimeMs = 600_000;
  });
  afterAll(async () => {
    await redis.quit();
    await database.close();
  });

  /** A run row; it started long before any cap window another spec looks at. */
  async function seedRun(
    status: SimulationStatus = SIMULATION_STATUS.QUEUED,
    metrics: SimulationMetrics | null = null
  ): Promise<string> {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 0,
    });
    const [row] = await db
      .insert(simulationRuns)
      .values({
        eventId,
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        buyers: 1,
        seats: 1,
        status,
        metrics,
        // A finished run always has its end time; the list of finished runs orders by it.
        finishedAt: status === SIMULATION_STATUS.FINISHED ? SPEC_NOW : null,
        startedBy: randomUUID(),
        startedAt: new Date(SPEC_NOW.getTime() - 5 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: simulationRuns.id });
    if (row === undefined) throw new Error('run insert returned no row');
    return row.id;
  }

  const publish = (runId: string, value: SimulationProgress | string) =>
    redis.set(
      simulationProgressKey(runId),
      typeof value === 'string' ? value : JSON.stringify(value),
      {
        EX: SIMULATION_PROGRESS_TTL_SECONDS,
      }
    );

  function listen(runId: string) {
    const messages: SimulationProgress[] = [];
    const state: { error?: Error; completed: boolean } = { completed: false };
    const subscription = service.stream(runId).subscribe({
      next: (message) => messages.push(message),
      error: (error: Error) => (state.error = error),
      complete: () => (state.completed = true),
    });
    open.push(subscription);
    return { messages, state };
  }
  const settle = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  it('emits the progress of the key, each change once, and completes after FINISHED', async () => {
    const runId = await seedRun();
    await publish(runId, progress(SIMULATION_STATUS.RUNNING));
    const { messages, state } = listen(runId);

    await expect.poll(() => messages).toHaveLength(1);
    await settle(POLL_MS * 4);
    const finished = progress(SIMULATION_STATUS.FINISHED, { ...METRICS, doubleBookings: 0 });
    await publish(runId, finished);

    await expect.poll(() => state.completed).toBe(true);
    expect(messages).toEqual([progress(SIMULATION_STATUS.RUNNING), finished]);
  });

  it('completes after FAILED', async () => {
    const runId = await seedRun();
    await publish(runId, progress(SIMULATION_STATUS.FAILED));
    const { messages, state } = listen(runId);

    await expect.poll(() => state.completed).toBe(true);
    expect(messages).toEqual([progress(SIMULATION_STATUS.FAILED)]);
  });

  it('falls back to the row when the key is absent: QUEUED with empty metrics', async () => {
    const runId = await seedRun(SIMULATION_STATUS.QUEUED);
    const { messages } = listen(runId);

    await expect.poll(() => messages).toEqual([progress(SIMULATION_STATUS.QUEUED, EMPTY_METRICS)]);
  });

  it('falls back to the final row once the key has expired, and completes', async () => {
    const finished = { ...METRICS, doubleBookings: 0 };
    const runId = await seedRun(SIMULATION_STATUS.FINISHED, finished);
    const { messages, state } = listen(runId);

    await expect.poll(() => state.completed).toBe(true);
    expect(messages).toEqual([progress(SIMULATION_STATUS.FINISHED, finished)]);
  });

  it('ends with an error for a run that does not exist', async () => {
    const { state } = listen(randomUUID());

    await expect.poll(() => state.error).toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['not JSON', 'not json'],
    ['not a progress payload', JSON.stringify({ status: SIMULATION_STATUS.RUNNING })],
  ])('ends with an error and emits nothing for a key that is %s', async (_name, value) => {
    const runId = await seedRun();
    await publish(runId, value);
    const { messages, state } = listen(runId);

    await expect.poll(() => state.error).toBeInstanceOf(Error);
    expect(messages).toEqual([]);
  });

  it('completes after its lifetime even while the run goes on', async () => {
    service.maxLifetimeMs = POLL_MS * 5;
    const runId = await seedRun();
    await publish(runId, progress(SIMULATION_STATUS.RUNNING));
    const { state } = listen(runId);

    await expect.poll(() => state.completed).toBe(true);
  });

  it('refuses a stream above the cap with 503 and frees a slot when a stream ends', async () => {
    service.maxStreams = 2;
    const runId = await seedRun();
    await publish(runId, progress(SIMULATION_STATUS.RUNNING));
    const first = listen(runId);
    listen(runId);

    expect(() => service.stream(runId)).toThrow(ServiceUnavailableException);

    open[0]?.unsubscribe();
    expect(first.state.completed).toBe(false);
    expect(() => listen(runId)).not.toThrow();
  });
});
