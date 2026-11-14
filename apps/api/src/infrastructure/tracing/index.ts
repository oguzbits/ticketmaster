export { acquireInstrumentation, useMeterProvider } from './instrumentation.js';
export { SPAN_ATTR, SPAN_NAME, withSpan } from './span.js';
export { currentTraceparent, withExtractedContext } from './trace-context.js';
export type { ServiceName, TracingHandle } from './tracing.js';
export { SERVICE_NAME, startTracing } from './tracing.js';
export { SpanKind } from '@opentelemetry/api';
