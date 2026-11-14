import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';

import { SERVICE_NAME, startTracing } from '../tracing.js';

/** Registers the tracing SDK with an in-memory exporter; call `shutdown` in `afterEach`. */
export function startTestTracing(): {
  exporter: InMemorySpanExporter;
  shutdown: () => Promise<void>;
} {
  const exporter = new InMemorySpanExporter();
  const handle = startTracing(
    { TRACING_ENABLED: true, TRACING_OTLP_ENDPOINT: 'http://localhost:4318' },
    { serviceName: SERVICE_NAME.API, spanProcessor: new SimpleSpanProcessor({ exporter }) }
  );
  if (!handle) throw new Error('tracing did not start');
  return { exporter, shutdown: () => handle.shutdown() };
}
