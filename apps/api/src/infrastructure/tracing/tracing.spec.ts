import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';

import { withSpan } from './span.js';
import { startTestTracing } from './testing/index.js';
import { isEventStreamRequest, SERVICE_NAME, startTracing, type TracingHandle } from './tracing.js';

const ENV_ON = { TRACING_ENABLED: true, TRACING_OTLP_ENDPOINT: 'http://localhost:4318' };
const ENV_OFF = { TRACING_ENABLED: false, TRACING_OTLP_ENDPOINT: 'http://localhost:4318' };

function collectingExporter(): { exporter: SpanExporter; spans: ReadableSpan[] } {
  const spans: ReadableSpan[] = [];
  return {
    spans,
    exporter: {
      export(batch, done) {
        spans.push(...batch);
        done({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    },
  };
}

describe('startTracing', () => {
  let handle: TracingHandle | null = null;
  afterEach(async () => {
    await handle?.shutdown();
    handle = null;
  });

  it('returns null and registers no tracer provider when tracing is off', () => {
    handle = startTracing(ENV_OFF, { serviceName: SERVICE_NAME.API });

    expect(handle).toBeNull();
    expect(trace.getTracer('probe').startSpan('probe').isRecording()).toBe(false);
  });

  it('exports a span and flushes the pending batch on shutdown', async () => {
    const { exporter, spans } = collectingExporter();
    const batch = new BatchSpanProcessor({ exporter, scheduledDelayMillis: 60_000 });
    handle = startTracing(ENV_ON, { serviceName: SERVICE_NAME.WORKER, spanProcessor: batch });

    await withSpan('probe', () => Promise.resolve());
    expect(spans).toHaveLength(0);
    await handle?.shutdown();
    handle = null;

    expect(spans.map((span) => span.name)).toEqual(['probe']);
    expect(spans[0]?.resource.attributes['service.name']).toBe(SERVICE_NAME.WORKER);
  });

  it('lets the callback finish when the export fails', async () => {
    const failing: SpanExporter = {
      export: (_batch, done) => done({ code: ExportResultCode.FAILED, error: new Error('down') }),
      shutdown: () => Promise.resolve(),
    };
    handle = startTracing(ENV_ON, {
      serviceName: SERVICE_NAME.API,
      spanProcessor: new SimpleSpanProcessor({ exporter: failing }),
    });

    await expect(withSpan('probe', () => Promise.resolve('booked'))).resolves.toBe('booked');
  });
});

describe('exported spans', () => {
  let shutdown: () => Promise<void>;
  afterEach(() => shutdown());

  it('carry no client address, user agent or query string, but keep the path', async () => {
    const started = startTestTracing();
    shutdown = started.shutdown;

    await withSpan('GET /api/events/:id', () => Promise.resolve(), {
      attributes: {
        'client.address': '203.0.113.7',
        'network.peer.address': '203.0.113.7',
        'network.peer.port': 51234,
        'user_agent.original': 'Mozilla/5.0',
        'url.query': 'email=a%40b.c',
        'url.path': '/api/events/42',
      },
    });

    const [span] = started.exporter.getFinishedSpans();
    expect(Object.keys(span?.attributes ?? {})).toEqual(['url.path']);
  });

  it('drops a queue receive root span but keeps one under a parent', async () => {
    const started = startTestTracing();
    shutdown = started.shutdown;
    const receive = {
      kind: SpanKind.CONSUMER,
      attributes: { 'messaging.operation.type': 'receive' },
    };
    const tracer = trace.getTracer('probe');

    tracer.startSpan('queue receive', receive, ROOT_CONTEXT).end();
    await withSpan('request', async () => {
      tracer.startSpan('queue receive', receive).end();
      return Promise.resolve();
    });

    expect(started.exporter.getFinishedSpans().map((span) => span.name)).toEqual([
      'queue receive',
      'request',
    ]);
  });
});

describe('isEventStreamRequest', () => {
  it('is true for a server-sent events request and false otherwise', () => {
    expect(isEventStreamRequest({ headers: { accept: 'text/event-stream' } })).toBe(true);
    expect(isEventStreamRequest({ headers: { accept: 'application/json' } })).toBe(false);
    expect(isEventStreamRequest({ headers: {} })).toBe(false);
  });
});
