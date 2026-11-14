import {
  context,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
} from '@opentelemetry/api';

const TRACEPARENT_VERSION = '00';
const TRACEPARENT_KEY = 'traceparent';

/** W3C `traceparent` of the active span, or null without a valid active span. */
export function currentTraceparent(): string | null {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return null;
  const flags = spanContext.traceFlags & TraceFlags.SAMPLED ? '01' : '00';
  return `${TRACEPARENT_VERSION}-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

/** Runs `fn` with the remote context of `traceparent`; null or a malformed value runs `fn` in a fresh root context (never throws). */
export function withExtractedContext<T>(
  traceparent: string | null,
  fn: () => Promise<T>
): Promise<T> {
  const carrier = traceparent === null ? {} : { [TRACEPARENT_KEY]: traceparent };
  return context.with(propagation.extract(ROOT_CONTEXT, carrier), fn);
}
