import type { IncomingMessage } from 'node:http';

import { context, type MeterProvider } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { type Instrumentation, registerInstrumentations } from '@opentelemetry/instrumentation';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const EVENT_STREAM = 'text/event-stream';
const HEALTH_PATH = /^\/health(\/|\?|$)/;
/** The scrape of the metrics listener runs through the same patched HTTP server. */
const METRICS_PATH = /^\/metrics(\?|$)/;

/** Server-sent event streams stay open for minutes: their span would end long after the work. */
export function isEventStreamRequest(request: Pick<IncomingMessage, 'headers'>): boolean {
  return request.headers.accept?.includes(EVENT_STREAM) ?? false;
}

/** Container health checks and probes hit `/health/*` every few seconds: one-span traces, no signal. */
export function isHealthProbe(request: Pick<IncomingMessage, 'url'>): boolean {
  return HEALTH_PATH.test(request.url ?? '');
}

/** A Prometheus scrape every few seconds would be the busiest "route" of the RED histogram. */
export function isMetricsScrape(request: Pick<IncomingMessage, 'url'>): boolean {
  return METRICS_PATH.test(request.url ?? '');
}

let holders = 0;
let unregister: (() => void) | undefined;
let registered: Instrumentation[] = [];

/**
 * The metrics API has no proxy provider (unlike tracing): an instrumentation registered before the
 * meter provider was set keeps a no-op meter until it is handed the provider.
 */
export function useMeterProvider(provider: MeterProvider): void {
  for (const instrumentation of registered) instrumentation.setMeterProvider(provider);
}

/**
 * Registers the HTTP, Express and AWS instrumentations and the context manager they need, once:
 * tracing and metrics both call this, and the second call only counts. The returned function
 * releases the claim; the last release unregisters. Spans stay no-ops without a tracer provider
 * and the histogram stays a no-op without a meter provider.
 */
export function acquireInstrumentation(): () => void {
  if (holders === 0) {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    registered = [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) =>
          isEventStreamRequest(request) || isHealthProbe(request) || isMetricsScrape(request),
      }),
      // Layer spans would bury the request: the server span keeps the route template as its name.
      new ExpressInstrumentation({
        ignoreLayersType: [
          ExpressLayerType.MIDDLEWARE,
          ExpressLayerType.ROUTER,
          ExpressLayerType.REQUEST_HANDLER,
        ],
      }),
      new AwsInstrumentation(),
    ];
    unregister = registerInstrumentations({ instrumentations: registered });
  }
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) {
      unregister?.();
      registered = [];
      context.disable();
    }
  };
}
