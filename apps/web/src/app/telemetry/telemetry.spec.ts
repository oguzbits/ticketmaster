import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';

import { type BrowserTracingHandle, startBrowserTracing } from './telemetry';

describe('startBrowserTracing', () => {
  const originalFetch = globalThis.fetch;
  let handle: BrowserTracingHandle | null = null;

  afterEach(async () => {
    await handle?.shutdown();
    handle = null;
    globalThis.fetch = originalFetch;
  });

  it('creates a span for API fetch calls, propagates traceparent and strips query strings', async () => {
    const exporter = new InMemorySpanExporter();
    let sentTraceparent: string | null = null;
    // SAFETY: local test stub replacing globalThis.fetch within afterEach-restored scope.
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sentTraceparent = new Headers(init?.headers).get('traceparent');
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    handle = startBrowserTracing({ spanProcessor: new SimpleSpanProcessor({ exporter }) });

    await fetch('http://localhost:8080/api/events?search=rock');
    // FetchInstrumentation ends spans after a short PerformanceObserver settle timer (~300 ms).
    await new Promise((resolve) => setTimeout(resolve, 400));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.resource.attributes['service.name']).toBe('ticketmaster-web');
    expect(spans[0]?.attributes['url.full']).toBe('http://localhost:8080/api/events');
    expect(spans[0]?.attributes['url.query']).toBeUndefined();
    expect(sentTraceparent).toMatch(new RegExp(`^00-${spans[0]?.spanContext().traceId}-`));
  });

  it('ignores trace exports, health probes and SSE stream endpoints', async () => {
    const exporter = new InMemorySpanExporter();
    // SAFETY: local test stub replacing globalThis.fetch within afterEach-restored scope.
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;

    handle = startBrowserTracing({ spanProcessor: new SimpleSpanProcessor({ exporter }) });

    await fetch('http://localhost:8080/v1/traces');
    await fetch('http://localhost:8080/health/live');
    await fetch('http://localhost:8080/api/events/1/seats/stream');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('scrubs personal attributes from custom browser spans', () => {
    const exporter = new InMemorySpanExporter();
    handle = startBrowserTracing({ spanProcessor: new SimpleSpanProcessor({ exporter }) });

    trace
      .getTracer('probe')
      .startSpan('ui.action', {
        attributes: {
          'client.address': '198.51.100.1',
          'user_agent.original': 'Mozilla/5.0',
          'url.query': 'secret=1',
          'url.path': '/events',
        },
      })
      .end();

    const [span] = exporter.getFinishedSpans();
    expect(Object.keys(span?.attributes ?? {})).toEqual(['url.path']);
  });
});
