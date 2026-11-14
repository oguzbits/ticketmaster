import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OUTBOX_STUCK_SECONDS } from '../../modules/outbox/index.js';
import { API_POOL_SIZE } from '../database/database.module.js';
import { METRIC } from './names.js';

const OBSERVABILITY_DIR = join(import.meta.dirname, '../../../../../docker/observability');
const DASHBOARD_DIR = join(OBSERVABILITY_DIR, 'grafana/provisioning/dashboards');
const PROMETHEUS_DATASOURCE_UID = 'prometheus';

const KIND = { COUNTER: 'counter', GAUGE: 'gauge', HISTOGRAM: 'histogram' } as const;
type Kind = (typeof KIND)[keyof typeof KIND];

/** Every instrument is classified here: a new METRIC key does not compile without a kind. */
const METRIC_KIND: Record<keyof typeof METRIC, Kind> = {
  HTTP_SERVER_DURATION: KIND.HISTOGRAM,
  HOLDS: KIND.COUNTER,
  BOOKINGS_SETTLED: KIND.COUNTER,
  QUEUE_EFFECTS: KIND.COUNTER,
  DB_QUERIES_ACTIVE: KIND.GAUGE,
  OUTBOX_OLDEST_AGE: KIND.GAUGE,
  QUEUE_DEPTH: KIND.GAUGE,
  WAITING_ROOM_WAITING: KIND.GAUGE,
};

const SUFFIXES: Record<Kind, string[]> = {
  counter: ['_total'],
  gauge: [''],
  histogram: ['_bucket', '_sum', '_count'],
};

/** The series names a scrape shows (ADR 0008): dots become underscores, counters get `_total`. */
const EMITTED_METRIC_NAMES = new Set(
  Object.entries(METRIC).flatMap(([key, name]) =>
    // SAFETY: Object.entries yields the keys of METRIC, which METRIC_KIND covers exhaustively.
    SUFFIXES[METRIC_KIND[key as keyof typeof METRIC]].map(
      (suffix) => name.replaceAll('.', '_') + suffix
    )
  )
);

const PROMQL_WORDS = new Set(['and', 'or', 'unless', 'bool']);

/** The metric names a PromQL expression reads: label matchers, strings, grouping clauses and functions are dropped. */
function metricNames(expr: string): string[] {
  const bare = expr
    .replace(/"[^"]*"/g, '""')
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\b(by|without|on|ignoring)\s*\([^)]*\)/g, '');
  return [...bare.matchAll(/(?<![\w$])[a-z_:][a-z0-9_:]*(?!\w|\s*\()/g)]
    .map((match) => match[0])
    .filter((word) => !PROMQL_WORDS.has(word));
}

/** Every `expr` string anywhere in a parsed document. */
function exprs(node: object): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === 'expr' && typeof value === 'string') return [value];
    return typeof value === 'object' && value !== null ? exprs(value) : [];
  });
}

interface Panel {
  datasource?: { uid: string };
  targets?: { datasource?: { uid: string } }[];
  fieldConfig?: { defaults?: { thresholds?: { steps: { value: number | null }[] } } };
}
interface Dashboard {
  uid: string;
  panels: Panel[];
}

const dashboards = readdirSync(DASHBOARD_DIR)
  .filter((file) => file.endsWith('.json'))
  .map((file) => ({
    file,
    // SAFETY: the shape is the Grafana dashboard JSON; the tests below fail on anything else.
    dashboard: JSON.parse(readFileSync(join(DASHBOARD_DIR, file), 'utf8')) as Dashboard,
  }));

/** The threshold values of the panels that read `metric`. */
function thresholds(file: string, metric: string): number[] {
  return dashboards
    .filter((entry) => entry.file === file)
    .flatMap((entry) => entry.dashboard.panels)
    .filter((panel) => exprs(panel).some((expr) => metricNames(expr).includes(metric)))
    .flatMap((panel) => panel.fieldConfig?.defaults?.thresholds?.steps ?? [])
    .flatMap((step) => (step.value === null ? [] : [step.value]));
}

describe('metricNames', () => {
  it('keeps metric names and drops functions, labels, strings, durations and variables', () => {
    expect(
      metricNames(
        'histogram_quantile(0.95, sum by (le, http_route) (rate(a_bucket{x="b_c"}[$__rate_interval]))) / on () b[5m] or vector(0)'
      )
    ).toEqual(['a_bucket', 'b']);
  });
});

describe('provisioned dashboards', () => {
  it('has the four dashboards, each with its own uid', () => {
    expect(dashboards.map((entry) => entry.file).sort()).toEqual([
      'api.json',
      'bookings.json',
      'queue-outbox.json',
      'waiting-room.json',
    ]);
    const uids = dashboards.map((entry) => entry.dashboard.uid);
    expect(new Set(uids).size).toBe(uids.length);
    expect(uids.every((uid) => uid.length > 0)).toBe(true);
  });

  it('queries only the Prometheus data source', () => {
    const uids = dashboards.flatMap(({ dashboard }) =>
      dashboard.panels.flatMap((panel) => [
        panel.datasource?.uid,
        ...(panel.targets ?? []).map((target) => target.datasource?.uid),
      ])
    );
    expect(new Set(uids)).toEqual(new Set([PROMETHEUS_DATASOURCE_UID]));
  });

  it.each(dashboards)('$file reads only metrics the services emit', ({ dashboard }) => {
    const names = exprs(dashboard).flatMap(metricNames);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !EMITTED_METRIC_NAMES.has(name))).toEqual([]);
  });

  it('marks the stuck-outbox age at OUTBOX_STUCK_SECONDS', () => {
    expect(thresholds('queue-outbox.json', 'tm_outbox_oldest_age')).toEqual([OUTBOX_STUCK_SECONDS]);
  });

  it('marks in-flight queries at the pool size', () => {
    expect(thresholds('api.json', 'tm_db_queries_active')).toEqual([API_POOL_SIZE]);
  });
});
