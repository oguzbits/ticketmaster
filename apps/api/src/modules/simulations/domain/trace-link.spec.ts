import { describe, expect, it } from 'vitest';

import { traceLink } from './trace-link.js';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;
const GRAFANA = 'http://localhost:3000';
const WINDOW = {
  from: new Date('2030-01-01T00:00:00.000Z'),
  to: new Date('2030-01-01T00:11:00.000Z'),
};

/** The Explore state of the link: its `panes` parameter, parsed. */
function panesOf(url: string) {
  const panes = new URL(url).searchParams.get('panes');
  if (panes === null) throw new Error('no panes parameter');
  return JSON.parse(panes) as Record<
    string,
    {
      datasource: string;
      queries: { query: string; queryType: string; datasource: { uid: string } }[];
      range: { from: string; to: string };
    }
  >; // SAFETY: the spec reads back the shape traceLink writes
}

describe('traceLink', () => {
  it('opens Explore on the tempo data source with the trace ID as the query', () => {
    const url = traceLink(GRAFANA, TRACEPARENT, WINDOW);
    expect(url?.startsWith(`${GRAFANA}/explore?`)).toBe(true);
    const [pane] = Object.values(panesOf(url ?? ''));
    expect(pane?.datasource).toBe('tempo');
    expect(pane?.queries[0]).toMatchObject({ query: TRACE_ID, queryType: 'traceql' });
    expect(pane?.range).toEqual({
      from: String(WINDOW.from.getTime()),
      to: String(WINDOW.to.getTime()),
    });
  });

  it('writes the Explore state Grafana expects: org, schema version, pane run and its query', () => {
    const url = new URL(traceLink(GRAFANA, TRACEPARENT, WINDOW) ?? '');
    expect(url.pathname).toBe('/explore');
    expect(url.searchParams.get('orgId')).toBe('1');
    expect(url.searchParams.get('schemaVersion')).toBe('1');
    expect(Object.keys(panesOf(url.toString()))).toEqual(['run']);
    expect(panesOf(url.toString()).run?.queries[0]).toEqual({
      refId: 'A',
      datasource: { type: 'tempo', uid: 'tempo' },
      queryType: 'traceql',
      query: TRACE_ID,
    });
  });

  it('puts the trace ID, not the span ID, into the link', () => {
    expect(traceLink(GRAFANA, TRACEPARENT, WINDOW)).not.toContain(SPAN_ID);
  });

  it('keeps a base URL with a trailing slash well formed', () => {
    expect(traceLink(`${GRAFANA}/`, TRACEPARENT, WINDOW)?.startsWith(`${GRAFANA}/explore?`)).toBe(
      true
    );
  });

  it('keeps the path of a Grafana served under a sub-path', () => {
    const url = traceLink('http://example.test/grafana', TRACEPARENT, WINDOW);
    expect(new URL(url ?? '').pathname).toBe('/grafana/explore');
  });

  it('is null without a Grafana URL, without a trace and for a malformed traceparent', () => {
    expect(traceLink(undefined, TRACEPARENT, WINDOW)).toBeNull();
    expect(traceLink(GRAFANA, null, WINDOW)).toBeNull();
    expect(traceLink(GRAFANA, 'garbage', WINDOW)).toBeNull();
  });

  it('accepts only a whole traceparent, not one with text before or after it', () => {
    expect(traceLink(GRAFANA, `x${TRACEPARENT}`, WINDOW)).toBeNull();
    expect(traceLink(GRAFANA, `${TRACEPARENT}x`, WINDOW)).toBeNull();
  });
});
