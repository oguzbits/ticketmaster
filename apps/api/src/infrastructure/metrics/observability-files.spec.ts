import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { API_PREFIX } from '../../app.setup.js';
import { BookingsModule } from '../../modules/bookings/index.js';
import { OUTBOX_STUCK_SECONDS } from '../../modules/outbox/index.js';
import { API_POOL_SIZE } from '../database/database.module.js';
import { METRIC } from './names.js';

const OBSERVABILITY_DIR = join(import.meta.dirname, '../../../../../docker/observability');
const DASHBOARD_DIR = join(OBSERVABILITY_DIR, 'grafana/provisioning/dashboards');
const PROMETHEUS_DATASOURCE_UID = 'prometheus';
const COMPOSE_FILE = join(OBSERVABILITY_DIR, '../../docker-compose.yml');
const DOC_FILE = join(OBSERVABILITY_DIR, '../../docs/observability.md');
const RUNBOOK = 'docs/observability.md#alerts';

const KIND = { COUNTER: 'counter', GAUGE: 'gauge', HISTOGRAM: 'histogram' } as const;
type Kind = (typeof KIND)[keyof typeof KIND];

/** Every instrument is classified here: a new METRIC key does not compile without a kind. */
const METRIC_KIND: Record<keyof typeof METRIC, Kind> = {
  HTTP_SERVER_DURATION: KIND.HISTOGRAM,
  HOLDS: KIND.COUNTER,
  BOOKINGS_SETTLED: KIND.COUNTER,
  QUEUE_EFFECTS: KIND.COUNTER,
  CACHE_REQUESTS: KIND.COUNTER,
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

describe('docs/observability.md', () => {
  it.each(Object.values(METRIC))('names the instrument %s', (name) => {
    expect(readFileSync(DOC_FILE, 'utf8')).toContain(`\`${name}\``);
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

interface AlertRule {
  alert: string;
  expr: string;
  for: string;
  labels: { severity: string };
  annotations: { summary?: string; runbook?: string };
}
interface RuleFile {
  groups: { rules: AlertRule[] }[];
}

const ALERT = {
  ERROR_RATIO: 'BookingErrorRatioHigh',
  BURN_FAST: 'BookingErrorBurnFast',
  BURN_SLOW: 'BookingErrorBurnSlow',
  HOLD_LATENCY: 'HoldLatencyHigh',
  PAYMENT_LATENCY: 'PaymentLatencyHigh',
  OUTBOX_STUCK: 'OutboxStuck',
  DLQ: 'DeadLetterQueueNotEmpty',
  TARGET_DOWN: 'ScrapeTargetDown',
  GAUGE_MISSING: 'GaugeSourceMissing',
  API_GONE: 'ApiAllReplicasGone',
  API_REPLICA_MISSING: 'ApiReplicaMissing',
} as const;

const SEVERITY = { PAGE: 'page', WARNING: 'warning' } as const;

/** SLO targets (docs/observability.md): the rules mirror them. Latency in seconds. */
const SLO = {
  ERROR_RATIO: 0.05,
  AVAILABILITY_ERROR_BUDGET: 0.005,
  FAST_BURN_MULTIPLIER: 14.4,
  SLOW_BURN_MULTIPLIER: 6,
  HOLD_P95_SECONDS: 0.5,
  PAYMENT_P95_SECONDS: 1,
} as const;

/** The routes of the availability SLO, as the `http_route` label shows them (global prefix included). */
const BOOKING_ROUTES = [
  '/api/bookings',
  '/api/bookings/:id/payment',
  '/api/bookings/:id/cancel',
] as const;

const EXPECTED_RULES: Record<string, { for: string; severity: string }> = {
  [ALERT.ERROR_RATIO]: { for: '5m', severity: SEVERITY.PAGE },
  [ALERT.BURN_FAST]: { for: '2m', severity: SEVERITY.PAGE },
  [ALERT.BURN_SLOW]: { for: '15m', severity: SEVERITY.WARNING },
  [ALERT.HOLD_LATENCY]: { for: '10m', severity: SEVERITY.WARNING },
  [ALERT.PAYMENT_LATENCY]: { for: '10m', severity: SEVERITY.WARNING },
  [ALERT.OUTBOX_STUCK]: { for: '1m', severity: SEVERITY.WARNING },
  [ALERT.DLQ]: { for: '1m', severity: SEVERITY.WARNING },
  [ALERT.TARGET_DOWN]: { for: '1m', severity: SEVERITY.WARNING },
  [ALERT.GAUGE_MISSING]: { for: '2m', severity: SEVERITY.WARNING },
  [ALERT.API_GONE]: { for: '1m', severity: SEVERITY.PAGE },
  [ALERT.API_REPLICA_MISSING]: { for: '1m', severity: SEVERITY.WARNING },
};

// SAFETY: the shape is the Prometheus rule file format; the tests below fail on anything else.
const ruleFile = parse(readFileSync(join(OBSERVABILITY_DIR, 'alerts.yml'), 'utf8')) as RuleFile;
const rules = ruleFile.groups.flatMap((group) => group.rules);

function rule(name: string): AlertRule {
  const found = rules.find((candidate) => candidate.alert === name);
  if (!found) throw new Error(`no rule ${name}`);
  return found;
}

/** The number a rule compares against: `... > 0.05` yields 0.05. */
function threshold(expr: string): number {
  const match = /[><]\s*([\d.]+)\s*$/.exec(expr.trim());
  if (!match?.[1]) throw new Error(`no threshold in ${expr}`);
  return Number(match[1]);
}

interface ComposeFile {
  services: {
    api: { deploy: { replicas: number } };
    prometheus: { volumes: string[] };
    alertmanager: { volumes: string[] };
  };
}
// SAFETY: the shape is the Compose file format; the tests below fail on anything else.
const compose = parse(readFileSync(COMPOSE_FILE, 'utf8')) as ComposeFile;

interface BookingsHandlers {
  hold: () => void;
  pay: () => void;
  cancel: () => void;
}
interface RouteController {
  prototype: BookingsHandlers;
}

/** The controller classes Nest keeps as metadata of a module: no DI scan needed. */
function bookingsControllers(): RouteController[] {
  // SAFETY: Nest stores the controller classes under MODULE_METADATA.CONTROLLERS.
  return Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, BookingsModule) as RouteController[];
}

/** The path segment of `@Controller('x')` or `@Post('y')`; empty for a bare decorator (stored as '/'). */
function routePath(target: object): string {
  // SAFETY: Nest stores the path of a controller or route handler as a string under PATH_METADATA.
  const path = Reflect.getMetadata(PATH_METADATA, target) as string;
  return path === '/' ? '' : path;
}

/** `up` is the synthetic series Prometheus writes for every scrape. */
const KNOWN_METRIC_NAMES = new Set([...EMITTED_METRIC_NAMES, 'up']);

describe('alert rules', () => {
  it('defines exactly the expected rules with their duration and severity', () => {
    expect(
      Object.fromEntries(rules.map((r) => [r.alert, { for: r.for, severity: r.labels.severity }]))
    ).toEqual(EXPECTED_RULES);
  });

  it('reads only metrics the services emit', () => {
    for (const { alert, expr } of rules) {
      const names = metricNames(expr);
      expect(names.length, alert).toBeGreaterThan(0);
      expect(
        names.filter((name) => !KNOWN_METRIC_NAMES.has(name)),
        alert
      ).toEqual([]);
    }
  });

  it('gives every rule a summary and a runbook link', () => {
    for (const { alert, annotations } of rules) {
      expect(annotations.summary?.length, alert).toBeGreaterThan(0);
      expect(annotations.runbook, alert).toBe(RUNBOOK);
    }
  });

  it('flags a stuck outbox at OUTBOX_STUCK_SECONDS', () => {
    expect(threshold(rule(ALERT.OUTBOX_STUCK).expr)).toBe(OUTBOX_STUCK_SECONDS);
  });

  it('mirrors the SLO and burn-rate targets', () => {
    expect(threshold(rule(ALERT.ERROR_RATIO).expr)).toBe(SLO.ERROR_RATIO);
    expect(threshold(rule(ALERT.BURN_FAST).expr)).toBeCloseTo(
      SLO.AVAILABILITY_ERROR_BUDGET * SLO.FAST_BURN_MULTIPLIER,
      6
    );
    expect(threshold(rule(ALERT.BURN_SLOW).expr)).toBeCloseTo(
      SLO.AVAILABILITY_ERROR_BUDGET * SLO.SLOW_BURN_MULTIPLIER,
      6
    );
    expect(threshold(rule(ALERT.HOLD_LATENCY).expr)).toBe(SLO.HOLD_P95_SECONDS);
    expect(threshold(rule(ALERT.PAYMENT_LATENCY).expr)).toBe(SLO.PAYMENT_P95_SECONDS);
  });

  it('measures the error ratio and burn rates on the three booking routes, 5xx against all', () => {
    for (const name of [ALERT.ERROR_RATIO, ALERT.BURN_FAST, ALERT.BURN_SLOW]) {
      const { expr } = rule(name);
      for (const route of BOOKING_ROUTES) expect(expr, name).toContain(route);
      expect(expr, name).toContain('5..');
    }
    expect(rule(ALERT.BURN_FAST).expr).toContain('[1h]');
    expect(rule(ALERT.BURN_FAST).expr).toContain('[5m]');
    expect(rule(ALERT.BURN_SLOW).expr).toContain('[6h]');
    expect(rule(ALERT.BURN_SLOW).expr).toContain('[30m]');
  });

  it('measures each latency on its own route', () => {
    expect(rule(ALERT.HOLD_LATENCY).expr).toContain(`http_route="${BOOKING_ROUTES[0]}"`);
    expect(rule(ALERT.PAYMENT_LATENCY).expr).toContain(`http_route="${BOOKING_ROUTES[1]}"`);
  });

  it('flags every target that does not answer its scrape', () => {
    expect(rule(ALERT.TARGET_DOWN).expr).toBe('up == 0');
  });

  it('flags an API target that left service discovery, which up == 0 cannot see', () => {
    // dns_sd drops a stopped container from the target list instead of marking it down.
    expect(rule(ALERT.API_GONE).expr).toBe('absent(up{job="api"} == 1)');
    const replicaMissing = rule(ALERT.API_REPLICA_MISSING).expr;
    expect(replicaMissing).toContain('count(up{job="api"} == 1) <');
    expect(threshold(replicaMissing)).toBe(compose.services.api.deploy.replicas);
  });

  it('labels the booking requests with the route templates of the controller and the global prefix', () => {
    const [controller] = bookingsControllers();
    if (!controller) throw new Error('BookingsModule has no controller');
    const route = (handler: keyof BookingsHandlers) =>
      '/' +
      [API_PREFIX, routePath(controller), routePath(controller.prototype[handler])]
        .filter(Boolean)
        .join('/');
    expect([route('hold'), route('pay'), route('cancel')]).toEqual([...BOOKING_ROUTES]);
  });

  it('watches the dead-letter queue by name', () => {
    expect(rule(ALERT.DLQ).expr).toContain('queue="booking-events-dlq"');
  });

  it('judges a worker gauge over a window, so a scrape that leaves it out does not reset the rule', () => {
    for (const alert of [ALERT.OUTBOX_STUCK, ALERT.DLQ]) {
      expect(rule(alert).expr, alert).toMatch(/^max_over_time\(tm_\w+(\{[^}]*\})?\[5m\]\)/);
    }
  });

  it('flags a worker gauge that is missing while the worker is up, for every gauge a rule reads', () => {
    // A gauge whose source is down is absent from the scrape, so its rule would go silent.
    const missing = rule(ALERT.GAUGE_MISSING).expr;
    expect(missing).toContain('up{job="worker"}');
    for (const alert of [ALERT.OUTBOX_STUCK, ALERT.DLQ]) {
      const [gauge] = metricNames(rule(alert).expr);
      expect(missing, alert).toContain(`absent_over_time(${gauge}`);
    }
  });

  it('is loaded by Prometheus and mounted into its container, with Alertmanager wired', () => {
    // SAFETY: the shape is the Prometheus config format; the assertions fail on anything else.
    const prometheus = parse(readFileSync(join(OBSERVABILITY_DIR, 'prometheus.yml'), 'utf8')) as {
      rule_files: string[];
      alerting: { alertmanagers: { static_configs: { targets: string[] }[] }[] };
    };
    const mounts = compose.services.prometheus.volumes.map((volume) => volume.split(':'));
    expect(prometheus.rule_files).toHaveLength(1);
    expect(mounts).toContainEqual([
      './docker/observability/alerts.yml',
      prometheus.rule_files[0],
      'ro',
    ]);
    expect(prometheus.alerting.alertmanagers[0]?.static_configs[0]?.targets).toEqual([
      'alertmanager:9093',
    ]);

    // SAFETY: the shape is the Alertmanager config format; the assertions below verify it.
    const alertmanager = parse(
      readFileSync(join(OBSERVABILITY_DIR, 'alertmanager.yml'), 'utf8')
    ) as {
      route: { receiver: string };
      receivers: { name: string }[];
    };
    expect(alertmanager.receivers.map((r) => r.name)).toContain(alertmanager.route.receiver);
    expect(compose.services.alertmanager.volumes.map((v) => v.split(':'))).toContainEqual([
      './docker/observability/alertmanager.yml',
      '/etc/alertmanager/alertmanager.yml',
      'ro',
    ]);
  });
});
