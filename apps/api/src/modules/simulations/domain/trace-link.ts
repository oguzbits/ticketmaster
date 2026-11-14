const TRACEPARENT_FORMAT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
const TEMPO = 'tempo';
const PANE_ID = 'run';
const SCHEMA_VERSION = 1;
const ORG_ID = 1;

/**
 * The Grafana Explore link to the trace of a run: the `tempo` data source with the trace ID as a
 * TraceQL query, over `window` (Grafana passes it to Tempo as a search hint, so it must cover the
 * trace). Null without a Grafana URL, without a trace and for a malformed `traceparent`.
 */
export function traceLink(
  grafanaUrl: string | undefined,
  traceparent: string | null,
  window: { from: Date; to: Date }
): string | null {
  const traceId = traceparent === null ? undefined : TRACEPARENT_FORMAT.exec(traceparent)?.[1];
  if (grafanaUrl === undefined || traceId === undefined) return null;
  const panes = {
    [PANE_ID]: {
      datasource: TEMPO,
      queries: [
        {
          refId: 'A',
          datasource: { type: TEMPO, uid: TEMPO },
          queryType: 'traceql',
          query: traceId,
        },
      ],
      range: { from: String(window.from.getTime()), to: String(window.to.getTime()) },
    },
  };
  const url = new URL('explore', grafanaUrl.endsWith('/') ? grafanaUrl : `${grafanaUrl}/`);
  url.searchParams.set('schemaVersion', String(SCHEMA_VERSION));
  url.searchParams.set('panes', JSON.stringify(panes));
  url.searchParams.set('orgId', String(ORG_ID));
  return url.toString();
}
