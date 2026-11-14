import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';

import { SPAN_NAME, withSpan } from '../tracing/index.js';
import { startTestTracing } from '../tracing/testing/index.js';
import { traceMixin } from './trace-mixin.js';

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

describe('traceMixin', () => {
  let shutdown: (() => Promise<void>) | undefined;
  afterEach(() => shutdown?.());

  it('adds nothing outside a span', () => {
    expect(traceMixin()).toEqual({});
  });

  it('adds the trace and span ID of the active span', async () => {
    shutdown = startTestTracing().shutdown;

    await withSpan(SPAN_NAME.OUTBOX_SEND, () => {
      const active = trace.getActiveSpan()?.spanContext();
      const fields = traceMixin();

      expect(fields.trace_id).toMatch(TRACE_ID);
      expect(fields.span_id).toMatch(SPAN_ID);
      expect(fields).toEqual({ trace_id: active?.traceId, span_id: active?.spanId });
      return Promise.resolve();
    });
  });
});
