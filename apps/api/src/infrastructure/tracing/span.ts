import { type Attributes, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = 'ticketmaster-klon';

export const SPAN_NAME = {
  OUTBOX_SEND: 'outbox.send',
  QUEUE_PROCESS: 'queue.process',
  QUEUE_EFFECT: 'queue.effect',
  HOLD_STRATEGY: 'booking.hold.strategy',
} as const;

export const SPAN_ATTR = {
  STRATEGY: 'booking.strategy',
  EFFECT: 'queue.effect',
  MESSAGE_ID: 'queue.message_id',
} as const;

/** Runs `fn` in a new active span; on a throw sets status ERROR with the error name only, ends the span, rethrows. */
export function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  options: { kind?: SpanKind; attributes?: Attributes } = {}
): Promise<T> {
  return trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(
      name,
      { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes ?? {} },
      async (span) => {
        try {
          return await fn();
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR, // The name only: a message may hold personal data.
            message: error instanceof Error ? error.name : typeof error,
          });
          throw error;
        } finally {
          span.end();
        }
      }
    );
}
