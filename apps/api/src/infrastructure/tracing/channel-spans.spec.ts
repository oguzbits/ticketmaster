import { tracingChannel } from 'node:diagnostics_channel';

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { subscribeDriverSpans } from './channel-spans.js';
import { DB_SYSTEM, SPAN_ATTR, SPAN_NAME, withSpan } from './span.js';
import { startTestProvider } from './testing/index.js';

const PARAMETER = 'ada@example.com';
const KEY = 'user:42:email';
const POSTGRES = tracingChannel('postgres:query');
const REDIS = tracingChannel('node-redis:command');

class PostgresError extends Error {
  override name = 'PostgresError';
}
// node-redis: the class is SimpleError, its `name` stays 'Error'.
class SimpleError extends Error {}

describe('driver channel spans', () => {
  let exporter: ReturnType<typeof startTestProvider>['exporter'];
  let shutdown: () => Promise<void>;
  let unsubscribe: () => void;
  beforeEach(() => {
    ({ exporter, shutdown } = startTestProvider());
    unsubscribe = subscribeDriverSpans();
  });
  afterEach(async () => {
    unsubscribe();
    await shutdown();
  });

  const queryEvent = (extra: object = {}) => ({
    query: 'select * from users where email = $1',
    parameters: [PARAMETER],
    database: 'app',
    ...extra,
  });
  const redisEvent = (extra: object = {}) => ({
    command: 'GET',
    args: ['GET', KEY],
    database: 0,
    ...extra,
  });
  // Everything a span could leak: its spans have circular references, so pick the data fields.
  const everything = (span?: ReadableSpan) =>
    JSON.stringify([span?.name, span?.attributes, span?.status, span?.events, span?.links]);
  const spans = () => exporter.getFinishedSpans();

  it('turns a postgres query into a client span below the active span, without the parameters', async () => {
    await withSpan('request', () => POSTGRES.tracePromise(() => Promise.resolve(), queryEvent()));

    const query = spans().find((span) => span.name === SPAN_NAME.DB_QUERY);
    const request = spans().find((span) => span.name === 'request');
    expect(query?.kind).toBe(SpanKind.CLIENT);
    expect(query?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    expect(query?.attributes[SPAN_ATTR.DB_SYSTEM]).toBe(DB_SYSTEM.POSTGRESQL);
    expect(query?.attributes[SPAN_ATTR.DB_STATEMENT]).toBe('select * from users where email = $1');
    expect(everything(query)).not.toContain(PARAMETER);
  });

  it('turns a redis command into a span with the command name and no key or argument', async () => {
    await withSpan('request', () => REDIS.tracePromise(() => Promise.resolve(), redisEvent()));

    const command = spans().find((span) => span.name === SPAN_NAME.REDIS_COMMAND);
    expect(command?.kind).toBe(SpanKind.CLIENT);
    expect(command?.attributes[SPAN_ATTR.DB_SYSTEM]).toBe(DB_SYSTEM.REDIS);
    expect(command?.attributes[SPAN_ATTR.DB_OPERATION]).toBe('GET');
    expect(everything(command)).not.toContain(KEY);
  });

  it.each([
    [
      'postgres',
      POSTGRES,
      queryEvent(),
      new PostgresError(`duplicate key ${PARAMETER}`),
      'PostgresError',
    ],
    ['redis', REDIS, redisEvent(), new SimpleError(`WRONGTYPE ${KEY}`), 'SimpleError'],
  ])(
    'ends the %s span with the error class name only when the call fails',
    async (_, channel, event, error, name) => {
      await withSpan('request', () =>
        channel.tracePromise(() => Promise.reject(error), event)
      ).catch(() => undefined);

      const failed = spans().find((span) => span.name !== 'request');
      expect(failed?.status).toEqual({ code: SpanStatusCode.ERROR, message: name });
      expect(everything(failed)).not.toContain(PARAMETER);
      expect(everything(failed)).not.toContain(KEY);
    }
  );

  it('records nothing after the unsubscribe', async () => {
    unsubscribe();

    await withSpan('request', async () => {
      await POSTGRES.tracePromise(() => Promise.resolve(), queryEvent());
      await REDIS.tracePromise(() => Promise.resolve(), redisEvent());
    });

    expect(spans().map((span) => span.name)).toEqual(['request']);
  });

  it('ignores a payload it cannot parse, without a span and without a throw', async () => {
    await withSpan('request', async () => {
      await POSTGRES.tracePromise(() => Promise.resolve(), { query: 42 });
      await POSTGRES.tracePromise(() => Promise.resolve(), {});
      await REDIS.tracePromise(() => Promise.resolve(), { command: ['GET'] });
    });

    expect(spans().map((span) => span.name)).toEqual(['request']);
  });

  it('creates no span without an active span: a background loop would only produce one-span traces', async () => {
    await POSTGRES.tracePromise(() => Promise.resolve(), queryEvent());
    await REDIS.tracePromise(() => Promise.resolve(), redisEvent());

    expect(spans()).toEqual([]);
  });
});
