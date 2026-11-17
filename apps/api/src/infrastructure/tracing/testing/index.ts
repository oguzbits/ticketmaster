import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { register } from 'import-in-the-middle/register-hooks.mjs';

import { SERVICE_NAME, startTracing } from '../tracing.js';

/** Re-exported for the specs of packages that do not depend on the API themselves. */
export { SpanStatusCode } from '@opentelemetry/api';

let hooksRegistered = false;

/**
 * What the preload does before the app imports Express: without the ESM hooks the instrumentations
 * do not patch what the spec imports. Call it before the first start, once per file.
 */
export function registerEsmHooks(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  register();
}

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

/**
 * A bare provider and context manager, without `startTracing`: for the specs that subscribe the
 * driver channels themselves. Call `shutdown` in `afterEach`.
 */
export function startTestProvider(): {
  exporter: InMemorySpanExporter;
  shutdown: () => Promise<void>;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  return {
    exporter,
    async shutdown() {
      await provider.shutdown();
      trace.disable();
      context.disable();
    },
  };
}
