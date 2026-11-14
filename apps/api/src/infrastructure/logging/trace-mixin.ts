import { isSpanContextValid, trace } from '@opentelemetry/api';

/** pino `mixin`: puts the IDs of the active span on a log line, nothing outside a trace. */
export function traceMixin(): { trace_id?: string; span_id?: string } {
  const context = trace.getActiveSpan()?.spanContext();
  return context && isSpanContextValid(context)
    ? { trace_id: context.traceId, span_id: context.spanId }
    : {};
}
