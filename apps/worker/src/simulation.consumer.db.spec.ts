import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { BookingsService } from '@app/api/bookings';
import { CLOCK } from '@app/api/clock';
import { type Database, DB } from '@app/api/database';
import { REDIS, type Redis } from '@app/api/redis';
import {
  ensureVenue,
  simulationProgressKey,
  SimulationRunner,
  SimulationsService,
} from '@app/api/simulations';
import {
  BOOKING_STRATEGY,
  SIMULATION_CONSUMER_GROUP,
  SIMULATION_STATUS,
  SimulationProgressSchema,
  type SimulationRun,
} from '@app/shared';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SimulationConsumer } from './simulation.consumer.js';
import { WorkerModule } from './worker.module.js';

// The cap of the start route counts the runs of the whole table inside a window around the clock:
// this file owns a day of its own, apart from the API specs (they use SPEC_NOW and the days after).
const NOW = new Date('2200-01-04T12:00:00.000Z');
const REQUEST = { buyers: 10, seats: 5, strategy: BOOKING_STRATEGY.PESSIMISTIC };
const PROGRESS_INTERVAL_MS = 20;
const BLOCK_MS = 200;
const ERROR_PAUSE_MS = 50;

describe('SimulationConsumer', () => {
  let moduleRef: TestingModule;
  let redis: Redis;
  let simulations: SimulationsService;
  let bookings: BookingsService;
  let streamKey: string;
  const consumers: SimulationConsumer[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(CLOCK)
      .useValue({ now: () => NOW })
      .compile();
    redis = moduleRef.get<Redis>(REDIS, { strict: false });
    simulations = moduleRef.get(SimulationsService, { strict: false });
    bookings = moduleRef.get(BookingsService, { strict: false });
    await ensureVenue(moduleRef.get<Database>(DB, { strict: false }));
  });
  beforeEach(() => {
    // A stream of its own per test: the API specs write to the real one.
    streamKey = `simulations:spec:${randomUUID()}`;
    simulations.streamKey = streamKey;
  });
  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((consumer) => consumer.onModuleDestroy()));
    await redis.del(streamKey);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await moduleRef.close();
  });

  /** A consumer on the spec's stream, not started yet. */
  function consumerWith(
    runner: SimulationRunner = moduleRef.get(SimulationRunner, { strict: false })
  ): SimulationConsumer {
    const consumer = new SimulationConsumer(redis, simulations, runner);
    consumer.streamKey = streamKey;
    consumer.blockMs = BLOCK_MS;
    consumer.errorPauseMs = ERROR_PAUSE_MS;
    consumers.push(consumer);
    return consumer;
  }

  async function startedConsumer(runner?: SimulationRunner): Promise<SimulationConsumer> {
    const consumer = consumerWith(runner);
    await consumer.onModuleInit();
    return consumer;
  }

  /** A runner whose bookings come from the real service, but may fail or stall per event. */
  function runnerOver(hold: BookingsService['hold']): SimulationRunner {
    return new SimulationRunner({
      bookings: { hold, countDoubleBookings: (eventId) => bookings.countDoubleBookings(eventId) },
      clock: { now: () => NOW },
      random: Math.random,
      newUserId: randomUUID,
      intervalMs: PROGRESS_INTERVAL_MS,
    });
  }

  const statusOf = async (run: SimulationRun) => (await simulations.find(run.id)).status;
  const untilStatus = (run: SimulationRun, status: string) =>
    expect.poll(() => statusOf(run), { timeout: 10_000 }).toBe(status);
  const pending = async () => (await redis.xPending(streamKey, SIMULATION_CONSUMER_GROUP)).pending;
  const untilAcknowledged = () => expect.poll(pending, { timeout: 10_000 }).toBe(0);
  const progressOf = async (run: SimulationRun) => {
    const raw = await redis.get(simulationProgressKey(run.id));
    return raw === null ? null : SimulationProgressSchema.parse(JSON.parse(raw));
  };

  it('runs a queued run to the end: metrics in the row, progress key, message acknowledged', async () => {
    await startedConsumer();
    const run = await simulations.start(REQUEST, randomUUID());

    await untilStatus(run, SIMULATION_STATUS.FINISHED);
    await untilAcknowledged();

    const finished = await simulations.find(run.id);
    expect(finished.metrics).toMatchObject({ buyersDone: REQUEST.buyers, doubleBookings: 0 });
    expect(finished.finishedAt).toBe(NOW.toISOString());
    expect(await progressOf(run)).toEqual({
      status: SIMULATION_STATUS.FINISHED,
      metrics: finished.metrics,
    });
  });

  it('stores a failing run as FAILED, acknowledges it and still runs the next message', async () => {
    let failingEvent = '';
    await startedConsumer(
      runnerOver((input) =>
        input.eventId === failingEvent ? Promise.reject(new Error('boom')) : bookings.hold(input)
      )
    );
    const broken = await simulations.start(REQUEST, randomUUID());
    failingEvent = broken.eventId;
    const next = await simulations.start(REQUEST, randomUUID());

    await untilStatus(broken, SIMULATION_STATUS.FAILED);
    await untilStatus(next, SIMULATION_STATUS.FINISHED);
    await untilAcknowledged();

    expect((await simulations.find(broken.id)).finishedAt).toBe(NOW.toISOString());
    expect((await progressOf(broken))?.status).toBe(SIMULATION_STATUS.FAILED);
  });

  it('acknowledges a malformed entry and an unknown run, logs them and keeps going', async () => {
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await startedConsumer();
    await redis.xAdd(streamKey, '*', { unexpected: 'field' });
    await redis.xAdd(streamKey, '*', { runId: 'not-a-uuid' });
    const unknownRunId = randomUUID();
    await redis.xAdd(streamKey, '*', { runId: unknownRunId });
    const run = await simulations.start(REQUEST, randomUUID());

    await untilStatus(run, SIMULATION_STATUS.FINISHED);
    await untilAcknowledged();

    const messages = warned.mock.calls.map(([message]) => String(message));
    expect(messages.filter((message) => message.includes('malformed'))).toHaveLength(2);
    expect(messages.filter((message) => message.includes(unknownRunId))).toHaveLength(1);
  });

  it('runs a command that is delivered twice only once', async () => {
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await startedConsumer();
    const run = await simulations.start(REQUEST, randomUUID());
    await untilStatus(run, SIMULATION_STATUS.FINISHED);
    const before = await simulations.find(run.id);

    await redis.xAdd(streamKey, '*', { runId: run.id });

    await expect
      .poll(() => warned.mock.calls.filter(([message]) => String(message).includes('already')))
      .toHaveLength(1);
    await untilAcknowledged();
    expect(await simulations.find(run.id)).toEqual(before);
  });

  it('lets two consumers of the group take two different runs, each delivered once', async () => {
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const takenByFirst = new Set<string>();
    const takenBySecond = new Set<string>();
    // A slow hold keeps a consumer busy, so the second message has to go to the other consumer.
    const slowRunner = (taken: Set<string>) =>
      runnerOver(async (input) => {
        taken.add(input.eventId);
        await sleep(100);
        return bookings.hold(input);
      });
    await startedConsumer(slowRunner(takenByFirst));
    await startedConsumer(slowRunner(takenBySecond));
    const first = await simulations.start(REQUEST, randomUUID());
    const second = await simulations.start(REQUEST, randomUUID());

    await untilStatus(first, SIMULATION_STATUS.FINISHED);
    await untilStatus(second, SIMULATION_STATUS.FINISHED);

    expect([takenByFirst.size, takenBySecond.size]).toEqual([1, 1]);
    expect(new Set([...takenByFirst, ...takenBySecond])).toEqual(
      new Set([first.eventId, second.eventId])
    );
    expect(warned).not.toHaveBeenCalled();
  });

  it('logs a failing iteration, recreates a lost group and keeps consuming', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await startedConsumer();
    // A Redis that lost its data: the blocked read fails because the stream and its group are gone.
    await redis.del(streamKey);
    await expect.poll(() => logged.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0);
    await sleep(ERROR_PAUSE_MS * 3);

    const run = await simulations.start(REQUEST, randomUUID());

    await untilStatus(run, SIMULATION_STATUS.FINISHED);
  });

  it('returns from shutdown while a blocking read is open', async () => {
    const consumer = consumerWith();
    consumer.blockMs = 30_000;
    await consumer.onModuleInit();
    await sleep(100);

    const outcome = await Promise.race([
      consumer.onModuleDestroy().then(() => 'closed'),
      sleep(2000).then(() => 'hanging'),
    ]);

    expect(outcome).toBe('closed');
  });
});
