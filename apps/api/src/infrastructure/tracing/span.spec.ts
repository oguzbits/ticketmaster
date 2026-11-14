import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';

import { SPAN_NAME, withSpan } from './span.js';
import { startTestTracing } from './testing/index.js';

class PaymentDeclined extends Error {
  override name = 'PaymentDeclined';
}

describe('withSpan', () => {
  let shutdown: () => Promise<void>;
  afterEach(() => shutdown());

  it('returns the value and exports a span of the given kind and attributes', async () => {
    const started = startTestTracing();
    shutdown = started.shutdown;

    const result = await withSpan(SPAN_NAME.OUTBOX_SEND, () => Promise.resolve(7), {
      kind: SpanKind.PRODUCER,
      attributes: { 'queue.message_id': 'm-1' },
    });

    const [span] = started.exporter.getFinishedSpans();
    expect(result).toBe(7);
    expect(span?.name).toBe(SPAN_NAME.OUTBOX_SEND);
    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.attributes['queue.message_id']).toBe('m-1');
  });

  it('rethrows, marks the span as failed with the error name only and records no exception', async () => {
    const started = startTestTracing();
    shutdown = started.shutdown;

    await expect(
      withSpan('pay', () => Promise.reject(new PaymentDeclined('card 4242 of ada@example.com')))
    ).rejects.toThrow(PaymentDeclined);

    const [span] = started.exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'PaymentDeclined' });
    expect(span?.events).toEqual([]);
  });

  it('nests: a span started inside is a child of the outer span', async () => {
    const started = startTestTracing();
    shutdown = started.shutdown;

    await withSpan('outer', () => withSpan('inner', () => Promise.resolve()));

    const spans = started.exporter.getFinishedSpans();
    const outer = spans.find((span) => span.name === 'outer');
    const inner = spans.find((span) => span.name === 'inner');
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
  });
});
