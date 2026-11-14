import { tracingChannel } from 'node:diagnostics_channel';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SERVICE_NAME } from '../tracing/index.js';
import { startMetrics } from './metrics.js';
import { METRIC } from './names.js';
import { dataPoints, startTestMetrics } from './testing/index.js';

const POSTGRES = tracingChannel('postgres:query');
const EVENT = { query: 'select 1', parameters: [], database: 'app' };

class PostgresError extends Error {
  override name = 'PostgresError';
}

describe('in-flight query counter', () => {
  let started: ReturnType<typeof startTestMetrics>;
  beforeEach(() => {
    started = startTestMetrics();
  });
  afterEach(async () => {
    await started.shutdown();
  });

  const inFlight = async () => {
    const [point] = dataPoints(await started.collect(), METRIC.DB_QUERIES_ACTIVE);
    return point?.value;
  };

  it('is 1 while a query is pending and 0 after it ended', async () => {
    let finish: () => void = () => undefined;
    const pending = POSTGRES.tracePromise(
      () => new Promise<void>((resolve) => (finish = resolve)),
      EVENT
    );

    expect(await inFlight()).toBe(1);
    finish();
    await pending;

    expect(await inFlight()).toBe(0);
  });

  it('counts a query that failed as ended', async () => {
    const failed = POSTGRES.tracePromise(() => Promise.reject(new PostgresError('boom')), EVENT);
    await failed.catch(() => undefined);

    expect(await inFlight()).toBe(0);
  });

  it('counts a query that threw before it returned a promise as ended', async () => {
    // Such a call publishes the error event only, no async end.
    expect(() =>
      POSTGRES.tracePromise(() => {
        throw new PostgresError('boom');
      }, EVENT)
    ).toThrow('boom');

    expect(await inFlight()).toBe(0);
  });

  it('counts concurrent queries', async () => {
    const finishers: (() => void)[] = [];
    const run = () =>
      POSTGRES.tracePromise(
        () => new Promise<void>((resolve) => finishers.push(resolve)),
        // The driver passes a context object of its own to every call.
        { ...EVENT }
      );
    const all = [run(), run(), run()];

    expect(await inFlight()).toBe(3);
    finishers.forEach((finish) => finish());
    await Promise.all(all);

    expect(await inFlight()).toBe(0);
  });

  it('stops counting after the metrics shut down', async () => {
    await started.shutdown();

    expect(POSTGRES.start.hasSubscribers).toBe(false);
    started = startTestMetrics();
  });
});

describe('with metrics off', () => {
  it('nothing subscribes to the driver channel', () => {
    startMetrics(
      { METRICS_ENABLED: false, METRICS_PORT: 9464, METRICS_HOST: '127.0.0.1' },
      { serviceName: SERVICE_NAME.API }
    );

    expect(POSTGRES.start.hasSubscribers).toBe(false);
  });
});
