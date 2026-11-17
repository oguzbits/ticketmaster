import { context, propagation, trace } from '@opentelemetry/api';
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
  StackContextManager,
  TracerProvider,
} from '@opentelemetry/sdk-trace';

export interface BrowserTracingHandle {
  shutdown(): Promise<void>;
}

const WEB_SERVICE_NAME = 'ticketmaster-web';
const DEFAULT_OTLP_ENDPOINT = '/v1/traces';
const EXPORT_DELAY_MS = 2000;
const EXPORT_TIMEOUT_MS = 2000;

const IGNORED_BROWSER_URLS: RegExp[] = [
  /\/v1\/traces(\?|$)/,
  /\/health(\/|\?|$)/,
  /\/stream(\?|$)/,
];
const PROPAGATED_API_URLS: RegExp[] = [/\/api\//];

const SCRUBBED_ATTRIBUTES = [
  'client.address',
  'network.peer.address',
  'network.peer.port',
  'user_agent.original',
  'url.query',
] as const;

class BrowserAttributeScrubber implements SpanProcessor {
  onStart(_span: Span): void {}

  onEnd(span: ReadableSpan): void {
    for (const key of SCRUBBED_ATTRIBUTES) delete span.attributes[key];
    const fullUrl = span.attributes['url.full'];
    if (typeof fullUrl === 'string') {
      const queryIndex = fullUrl.indexOf('?');
      if (queryIndex !== -1) span.attributes['url.full'] = fullUrl.slice(0, queryIndex);
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function buildOtlpProcessor(endpoint: string): SpanProcessor {
  return new BatchSpanProcessor({
    exporter: new OTLPTraceExporter({
      url: endpoint,
      timeoutMillis: EXPORT_TIMEOUT_MS,
      headers: {},
    }),
    scheduledDelayMillis: EXPORT_DELAY_MS,
    exportTimeoutMillis: EXPORT_TIMEOUT_MS,
  });
}

/**
 * Registers OpenTelemetry browser tracing for `fetch` API calls with W3C `traceparent` propagation
 * and PII scrubbing. Loaded lazily after app bootstrap only when the backend signals tracing is on.
 */
export function startBrowserTracing(options?: {
  endpoint?: string;
  spanProcessor?: SpanProcessor;
}): BrowserTracingHandle {
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': WEB_SERVICE_NAME }),
    spanProcessors: [
      new BrowserAttributeScrubber(),
      options?.spanProcessor ?? buildOtlpProcessor(options?.endpoint ?? DEFAULT_OTLP_ENDPOINT),
    ],
  });
  context.setGlobalContextManager(new StackContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator()] })
  );
  const unregister = registerInstrumentations({
    instrumentations: [
      new FetchInstrumentation({
        ignoreUrls: IGNORED_BROWSER_URLS,
        propagateTraceHeaderCorsUrls: PROPAGATED_API_URLS,
      }),
    ],
  });

  return {
    async shutdown() {
      unregister();
      await provider.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}
