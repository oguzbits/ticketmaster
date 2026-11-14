import { afterEach, describe, expect, it } from 'vitest';

import { SPAN_NAME, withSpan } from './span.js';
import { startTestTracing } from './testing/index.js';
import { currentTraceparent, withExtractedContext } from './trace-context.js';

const TRACEPARENT_FORMAT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const REMOTE = `00-${TRACE_ID}-b7ad6b7169203331-01`;

describe('trace context', () => {
  let shutdown: () => Promise<void>;
  afterEach(() => shutdown());

  it('has no traceparent outside a span and a W3C one inside', async () => {
    shutdown = startTestTracing().shutdown;

    expect(currentTraceparent()).toBeNull();
    const inside = await withSpan('probe', () => Promise.resolve(currentTraceparent()));

    expect(inside).toMatch(TRACEPARENT_FORMAT);
  });

  it('continues the trace of a remote traceparent', async () => {
    shutdown = startTestTracing().shutdown;

    const inside = await withExtractedContext(REMOTE, () =>
      withSpan(SPAN_NAME.QUEUE_PROCESS, () => Promise.resolve(currentTraceparent()))
    );

    expect(inside?.split('-')[1]).toBe(TRACE_ID);
  });

  it.each([null, '', 'garbage', `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`])(
    'runs the callback in a new trace for %j',
    async (traceparent) => {
      shutdown = startTestTracing().shutdown;

      const { outer, inside } = await withSpan('outer', async () => ({
        outer: currentTraceparent(),
        inside: await withExtractedContext(traceparent, () =>
          withSpan('inner', () => Promise.resolve(currentTraceparent()))
        ),
      }));

      expect(inside).toMatch(TRACEPARENT_FORMAT);
      expect(inside?.split('-')[1]).not.toBe(TRACE_ID);
      expect(inside?.split('-')[1]).not.toBe(outer?.split('-')[1]);
    }
  );
});
