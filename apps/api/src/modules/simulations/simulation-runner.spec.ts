import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Clock } from '../../core/clock.js';
import { HOLD_OUTCOME, type HoldInput, type HoldResult } from '../bookings/index.js';
import { SimulationRunner } from './simulation-runner.js';

const EVENT_ID = randomUUID();
const PLACED: HoldResult = {
  outcome: HOLD_OUTCOME.PLACED,
  bookingId: randomUUID(),
  holdExpiresAt: new Date(0),
};
// Pinned on purpose: a change of the bound in the runner must show up here.
const ATTEMPTS_PER_BUYER = 3;
const SEATS = ['seat-1', 'seat-2', 'seat-3'];

type Hold = (input: HoldInput) => Promise<HoldResult>;

function build(hold: Hold, overrides: { clock?: Clock; intervalMs?: number } = {}) {
  let next = 0;
  return new SimulationRunner({
    bookings: { hold, countDoubleBookings: () => Promise.resolve(4) },
    clock: overrides.clock ?? { now: () => new Date(0) },
    // Cycles through the seats, so every pick is predictable.
    random: () => ((next++ % SEATS.length) + 0.5) / SEATS.length,
    newUserId: randomUUID,
    intervalMs: overrides.intervalMs ?? 1000,
  });
}

function run(
  runner: SimulationRunner,
  buyers: number,
  concurrency: number,
  progress: number[] = []
) {
  return runner.run({
    runId: randomUUID(),
    eventId: EVENT_ID,
    buyers,
    seats: SEATS,
    concurrency,
    onProgress: (metrics) => progress.push(metrics.buyersDone),
  });
}

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('SimulationRunner', () => {
  it('maps each hold outcome to its counter and takes the double bookings from the service', async () => {
    const outcomes: HoldResult[] = [
      { outcome: HOLD_OUTCOME.SEAT_TAKEN },
      { outcome: HOLD_OUTCOME.CONSTRAINT_VIOLATION },
      PLACED,
    ];
    // Concurrency 1: the outcomes come in this order, the buyer retries until PLACED.
    const hold: Hold = () => Promise.resolve(outcomes.shift() ?? PLACED);

    const metrics = await run(build(hold), 1, 1);

    expect(metrics).toMatchObject({
      attempts: 3,
      holds: 1,
      conflicts: 1,
      constraintViolations: 1,
      retries: 2,
      buyersDone: 1,
      doubleBookings: 4,
    });
  });

  it('gives a buyer at most MAX_ATTEMPTS_PER_BUYER attempts', async () => {
    const buyers = 7;

    const metrics = await run(
      build(() => Promise.resolve({ outcome: HOLD_OUTCOME.SEAT_TAKEN })),
      buyers,
      3
    );

    expect(metrics.attempts).toBe(buyers * ATTEMPTS_PER_BUYER);
    expect(metrics.retries).toBe(buyers * (ATTEMPTS_PER_BUYER - 1));
    expect(metrics.buyersDone).toBe(buyers);
  });

  it('never has more buyers in flight than the concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const hold: Hold = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(2);
      inFlight -= 1;
      return PLACED;
    };

    await run(build(hold), 30, 7);

    expect(maxInFlight).toBe(7);
  });

  it('measures the latency of each attempt with the clock', async () => {
    let now = 0;
    const clock: Clock = { now: () => new Date(now) };
    const hold: Hold = () => {
      now += 25;
      return Promise.resolve(PLACED);
    };

    const metrics = await run(build(hold, { clock }), 5, 1);

    expect(metrics).toMatchObject({ p50Ms: 25, p95Ms: 25 });
  });

  it('reports progress while running and last with every buyer done', async () => {
    const progress: number[] = [];
    const hold: Hold = async () => {
      await tick(20);
      return PLACED;
    };

    await run(build(hold, { intervalMs: 10 }), 10, 2, progress);

    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toBe(10);
    expect(progress.slice(0, -1).every((done) => done < 10)).toBe(true);
  });

  it('stops the other buyers and rejects when a hold throws', async () => {
    let calls = 0;
    const hold: Hold = async () => {
      calls += 1;
      const call = calls;
      await tick(1);
      if (call === 1) throw new Error('database down');
      return PLACED;
    };

    await expect(run(build(hold), 100, 2)).rejects.toThrow('database down');
    await tick(30);
    // The second buyer in flight may finish; no new buyer starts.
    expect(calls).toBeLessThanOrEqual(2);
  });
});
