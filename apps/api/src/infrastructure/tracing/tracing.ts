import {
  type Attributes,
  type Context,
  type Link,
  propagation,
  SpanKind,
  trace,
} from '@opentelemetry/api';
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  type ReadableSpan,
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  type Span,
  type SpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';

import type { Env } from '../../config/env.js';
import { subscribeDriverSpans } from './channel-spans.js';
import { acquireInstrumentation } from './instrumentation.js';
import type { ServiceName } from './service-name.js';

export { isEventStreamRequest, isHealthProbe } from './instrumentation.js';
export { SERVICE_NAME, type ServiceName } from './service-name.js';

export interface TracingHandle {
  shutdown(): Promise<void>;
}

const RESOURCE_SERVICE_NAME = 'service.name';
const OTLP_TRACES_PATH = '/v1/traces';
// Tempo being down must cost a request nothing: short timeouts, spans dropped when the queue is full.
// The queue keeps the SDK default (2048): a 50-buyer simulation run puts ~780 spans in one trace.
const EXPORT_TIMEOUT_MS = 2000;
const EXPORT_DELAY_MS = 2000;

/** Personal data under invariant 6: the client's address and agent, and the query string. */
const PERSONAL_ATTRIBUTES = [
  'client.address',
  'network.peer.address',
  'network.peer.port',
  'user_agent.original',
  'url.query',
] as const;

/** The long poll of an SQS consumer is a root CONSUMER span per call, empty ones included. */
const RECEIVE_ATTRIBUTE = 'messaging.operation.type';
const RECEIVE_OPERATION = 'receive';

/** Deletes the personal attributes before the exporter sees the span (processors run in order). */
class PersonalDataFilter implements SpanProcessor {
  onStart(_span: Span): void {}
  onEnd(span: ReadableSpan): void {
    for (const key of PERSONAL_ATTRIBUTES) delete span.attributes[key];
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Parent-based, except that a parentless queue receive span is not recorded. */
class DropReceiveRootSampler implements Sampler {
  private readonly parentBased = new ParentBasedSampler({ root: new AlwaysOnSampler() });

  // eslint-disable-next-line max-params -- the Sampler interface fixes this signature
  shouldSample(
    ctx: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    const isReceiveRoot =
      spanKind === SpanKind.CONSUMER &&
      attributes[RECEIVE_ATTRIBUTE] === RECEIVE_OPERATION &&
      trace.getSpanContext(ctx) === undefined;
    if (isReceiveRoot) return { decision: SamplingDecision.NOT_RECORD };
    return this.parentBased.shouldSample(ctx, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return 'DropReceiveRootSampler';
  }
}

function otlpProcessor(endpoint: string): SpanProcessor {
  // Every option is explicit: the exporter would otherwise fall back to OTEL_EXPORTER_OTLP_*.
  const exporter = new OTLPTraceExporter({
    url: `${endpoint}${OTLP_TRACES_PATH}`,
    timeoutMillis: EXPORT_TIMEOUT_MS,
    compression: CompressionAlgorithm.NONE,
    headers: {},
  });
  return new BatchSpanProcessor({
    exporter,
    scheduledDelayMillis: EXPORT_DELAY_MS,
    exportTimeoutMillis: EXPORT_TIMEOUT_MS,
  });
}

/**
 * Assembles the SDK from its parts (no `NodeSDK`: it reads `OTEL_*` and starts metrics and log
 * exporters, see ADR 0007). Returns null and registers nothing when tracing is off.
 */
export function startTracing(
  env: Pick<Env, 'TRACING_ENABLED' | 'TRACING_OTLP_ENDPOINT'>,
  options: { serviceName: ServiceName; spanProcessor?: SpanProcessor }
): TracingHandle | null {
  if (!env.TRACING_ENABLED) return null;

  const provider = new TracerProvider({
    resource: resourceFromAttributes({ [RESOURCE_SERVICE_NAME]: options.serviceName }),
    sampler: new DropReceiveRootSampler(),
    spanProcessors: [
      new PersonalDataFilter(),
      options.spanProcessor ?? otlpProcessor(env.TRACING_OTLP_ENDPOINT),
    ],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator()] })
  );
  const unsubscribeDrivers = subscribeDriverSpans();
  const releaseInstrumentation = acquireInstrumentation();

  return {
    async shutdown() {
      unsubscribeDrivers();
      releaseInstrumentation();
      await provider.shutdown();
      trace.disable();
      propagation.disable();
    },
  };
}
