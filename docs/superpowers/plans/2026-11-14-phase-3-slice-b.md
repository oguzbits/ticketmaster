# Phase 3, slice B: metrics, dashboards, alerts, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prometheus scrapes RED metrics per route and business metrics from API and worker; four provisioned Grafana dashboards show them; alert rules guard the written SLOs, a stuck outbox, a non-empty dead-letter queue and a scrape target that is down.

**Architecture:** A `startMetrics` module (next to `startTracing`, same preload) builds an OpenTelemetry `MeterProvider` with a Prometheus exporter that serves `/metrics` on its own port (`METRICS_PORT`, default 9464, never published to the host). The official HTTP instrumentation produces the RED histogram. Business events go through one port, `BusinessMetrics`, defined in `apps/api/src/core` and implemented by an OTel adapter, so the domain and the services stay free of the SDK. Gauges that describe shared state (outbox age, queue depth, waiting room length) are observed by the worker only, so several API replicas do not report them twice. Prometheus, the dashboards and the rules are files under `docker/observability/`, loaded at start by the Compose profile `observability`.

**Tech Stack:** `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-prometheus` (versions read from the registry in Task 1, matching the 0.301.x / 3.1.x line of the installed packages), Prometheus, Grafana 13 provisioning, Vitest.

**Spec:** [Phase 3 design, slice B](../specs/2026-11-14-phase-3-observability-and-measuring-design.md#slice-b-metrics-dashboards-alerts)

## Global Constraints

- AGENTS.md applies: no `vi.mock`, no `any`, no `as unknown as`, no `export *`, no `unknown` as a parameter or return type, relative imports end in `.js`, modules import each other through `index.ts`, `// SAFETY:` on every assertion except `as const`, English docs, Conventional Commits straight on `main`, hooks never skipped, `pnpm check` green before every commit, `pnpm docs:generate` after env changes.
- Env only through the config module; no `OTEL_*` variable is set anywhere (the SDK would read it from `process.env`). New env: `METRICS_ENABLED` (`z.stringbool().default(false)`), `METRICS_PORT` (port number, default 9464); both in `.env.example`.
- With `METRICS_ENABLED=false` (default and every test project) no provider, no exporter and no listening socket exists.
- Metric and label names are `as const` dictionaries (`METRIC`, `METRIC_ATTR`) imported by code and tests (`pnpm audit:magic`). Label values come from existing dictionaries (`BOOKING_STATUS`, `HOLD_OUTCOME`, the strategy enum, `QUEUE_NAME`).
- **Cardinality and personal data:** no user, booking, event, seat or message ID and no raw URL in any label. The route label is the route template; a request that matched no route gets the fixed value `UNMATCHED`.
- The domain and `core` import no OpenTelemetry. The port lives in `apps/api/src/core/business-metrics.ts`.
- Shared state is observed once: observable gauges for outbox, queue and waiting room are registered by the worker only.
- Time only from `Clock`. Images are pinned by tag; versions of Prometheus and the npm packages are read from the registry (AGENTS rule 9). `df -h` before the first image pull (about 18 GiB free at the start of this slice).
- A stated limit in code gets `// shortcut: <limit>, <when to upgrade>`.

## Deviations from the spec (decided here)

- **Alert rules are Prometheus rule files, not Grafana-managed rules.** Grafana provisioned alert rules need a hand-built expression graph per rule; Prometheus rules are plain PromQL, checkable with `promtool`, and Grafana shows them read-only through the data source. Delivery stays out of scope either way.
- **Pool saturation is in-flight queries, not pool usage.** postgres.js exposes no pool statistics. The driver channel already carries query start and end, so an up-down counter of in-flight queries is compared with the pool size (20) on the dashboard.
- **`METRICS_ENABLED` is separate from `TRACING_ENABLED`.** The Compose profile needs both on; the docs show one command that sets both.
- **ADR 0008** records the exporter choice and the Task 1 spike result (written in Task 1).

## Interfaces (exact signatures)

```ts
// apps/api/src/config/env.ts (EnvSchema gains)
METRICS_ENABLED: z.stringbool().default(false),
METRICS_PORT: z.coerce.number().int().min(1).max(MAX_PORT).default(9464),

// apps/api/src/infrastructure/metrics/metrics.ts
export interface MetricsHandle { shutdown(): Promise<void> }
export function startMetrics(
  env: Pick<Env, 'METRICS_ENABLED' | 'METRICS_PORT'>,
  options: { serviceName: ServiceName; reader?: MetricReader } // reader: test seam, replaces the Prometheus exporter
): MetricsHandle | null // null when disabled

// apps/api/src/infrastructure/metrics/names.ts
export const METRIC = { /* OTel instrument names, see table below */ } as const
export const METRIC_ATTR = { STRATEGY: 'strategy', OUTCOME: 'outcome', STATUS: 'status', QUEUE: 'queue', EFFECT: 'effect' } as const

// apps/api/src/core/business-metrics.ts
export interface BusinessMetrics {
  holdAttempted(strategy: BookingStrategy, outcome: HoldOutcome): void
  bookingSettled(status: BookingStatus, count?: number): void // after the commit; count defaults to 1
  effectProcessed(effect: string, outcome: EffectOutcome): void
}
export const BUSINESS_METRICS = Symbol('BUSINESS_METRICS')
export const EFFECT_OUTCOME = { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED' } as const
```

Instruments (OTel name → Prometheus name as the exporter writes it; Task 1 verifies the mapping and fixes the table if it differs):

| OTel name                      | Kind                 | Labels                | Prometheus name                          | Emitted by                                                 |
| ------------------------------ | -------------------- | --------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `http.server.request.duration` | histogram (s)        | method, route, status | `http_server_request_duration_seconds_*` | API (HTTP instrumentation)                                 |
| `tm.holds`                     | counter              | strategy, outcome     | `tm_holds_total`                         | API                                                        |
| `tm.bookings.settled`          | counter              | status                | `tm_bookings_settled_total`              | API (pay, cancel), worker (expiry)                         |
| `tm.queue.effects`             | counter              | effect, outcome       | `tm_queue_effects_total`                 | worker                                                     |
| `tm.db.queries.active`         | up-down counter      | none                  | `tm_db_queries_active`                   | API, worker                                                |
| `tm.outbox.oldest_age`         | observable gauge (s) | none                  | `tm_outbox_oldest_age_seconds`           | worker only; 0 when no row waits                           |
| `tm.queue.depth`               | observable gauge     | queue                 | `tm_queue_depth`                         | worker only; queues `booking-events`, `booking-events-dlq` |
| `tm.waiting_room.waiting`      | observable gauge     | none                  | `tm_waiting_room_waiting`                | worker only; sum over events                               |

## Review Focus

- A request to an unknown path or with an ID in the URL must not create a series per URL (route label is the template or `UNMATCHED`) — pinned in Task 1.
- A payment that fails or is rolled back must not count as settled (increment after commit only) — Task 2.
- A gauge callback that fails (Redis or SQS down) must not hang the scrape or report a stale zero: the observation is omitted and the failure is logged by error name — Task 3.
- The metrics port answering without tracing, and tracing without metrics, both start cleanly — Task 1.
- A dashboard or rule that names a metric nothing emits (a typo) fails the build — Tasks 5 and 6.

---

### Task 1: Spike, ADR and `startMetrics` with the RED histogram

Reviewed by `pruefer` (new listening port, new attack surface).

**Files:**

- Create: `apps/api/src/infrastructure/metrics/{index,metrics,names}.ts`, `metrics.spec.ts`, `testing/index.ts`, `docs/adr/0008-metrics-with-opentelemetry.md`
- Modify: `apps/api/src/config/env.ts`, `.env.example`, `apps/api/src/infrastructure/tracing/tracing.ts` (instrumentation registration), `apps/api/src/tracing.preload.ts`, `apps/worker/src/tracing.preload.ts`, `apps/api/package.json`, `pnpm-lock.yaml` (by pnpm only), `docs/docs-map.json`

**Interfaces:**

- Consumes: `ServiceName`, `SERVICE_NAME`, `Env` (existing).
- Produces: `startMetrics`, `MetricsHandle`, `METRIC`, `METRIC_ATTR` (signatures above); `startTestMetrics(): { reader: InMemory-style MetricReader; collect(): Promise<ResourceMetrics>; shutdown(): Promise<void> }` in `metrics/testing/index.ts`.

- [ ] **Step 1: Spike (no commit of code yet).** Read the registry for the current `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-prometheus` versions that match the installed `api`/`instrumentation` line. In a scratch script (scratchpad dir) check three facts against the installed `@opentelemetry/instrumentation-http`: (a) it records `http.server.request.duration` once a global `MeterProvider` is set, (b) the metric carries the route template (`http.route`) for an Express route, (c) which Prometheus names the exporter writes for the table above. If (b) fails, fall back to an Express `res.on('finish')` hook registered in `configureApp` that records the same instrument with `req.route?.path ?? 'UNMATCHED'`; the instrument name and labels stay as in the table.
- [ ] **Step 2: Write ADR 0008** (MADR, rejected: `prom-client` and a `/metrics` Nest route, because it needs its own HTTP server in the worker anyway and duplicates what the HTTP instrumentation records; NodeSDK, same reason as ADR 0007) with the spike result.
- [ ] **Step 3: Write the failing tests** in `metrics.spec.ts` (test reader via `options.reader`, no socket):
  - `startMetrics({METRICS_ENABLED:false,…})` returns `null` and `metrics.getMeterProvider()` stays the no-op provider.
  - with a request through a Nest/Express test app, `http.server.request.duration` has `route = '/api/bookings/:id/payment'` for `POST /api/bookings/<uuid>/payment` and a data point count of 1.
  - a request to `/nope/<uuid>` produces `route = 'UNMATCHED'` and no attribute value contains the uuid (**guard:** replace the template lookup with the raw path, the test fails).
  - one socket test (`*.db.spec.ts` not needed): with the real exporter on an ephemeral `METRICS_PORT`, `GET /metrics` answers 200 with `http_server_request_duration_seconds_bucket`; after `shutdown()` the port is closed.
- [ ] **Step 4: Implement.** `startMetrics` builds `MeterProvider` (resource `service.name`), registers it globally, attaches `options.reader ?? new PrometheusExporter({ port: env.METRICS_PORT })`. Env fields and `.env.example` entries added, `pnpm docs:generate` run. HTTP instrumentation must be registered exactly once when either `TRACING_ENABLED` or `METRICS_ENABLED` is on: move the registration out of the `TRACING_ENABLED` early return in `tracing.ts` (spans stay no-ops without a provider). Both preloads call `startMetrics` after `startTracing` and shut it down on SIGTERM.
- [ ] **Step 5: Run** `pnpm --filter @app/api test -- metrics tracing` and `pnpm check`. Expected: green, existing tracing specs unchanged.
- [ ] **Step 6: Commit** `feat(metrics): serve RED metrics from API and worker` with the spike result in the body. Add the docs-map entry `apps/api/src/infrastructure/metrics/` → `docs/observability.md` and a short "Metrics" section (scrape port, flags, RED histogram) to that file in the same commit; Task 7 extends it.

### Task 2: Business metrics port, adapter and the booking counters

**Files:**

- Create: `apps/api/src/core/business-metrics.ts`, `apps/api/src/infrastructure/metrics/otel-business-metrics.ts` + `.spec.ts`, `apps/api/src/infrastructure/metrics/metrics.module.ts`, `apps/api/src/modules/bookings/testing/recording-metrics.ts`
- Modify: `apps/api/src/infrastructure/metrics/names.ts`, `bookings.service.ts`, `bookings.module.ts`, `apps/api/src/app.module.ts`, `apps/worker/src/worker.module.ts`, `apps/api/src/modules/bookings/testing/index.ts` (`createBookingsService` takes an optional `BusinessMetrics`, default no-op), `bookings.service` specs

**Interfaces:**

- Consumes: `startMetrics` (Task 1; the adapter takes the meter from `metrics.getMeter(...)`, a no-op when disabled).
- Produces: `BusinessMetrics`, `BUSINESS_METRICS`, `EFFECT_OUTCOME`; `MetricsModule` (global, provides `BUSINESS_METRICS`); `RecordingMetrics implements BusinessMetrics` with `calls: readonly { method: string; args: readonly (string|number)[] }[]` for specs.

- [ ] **Step 1: Failing tests** in the existing bookings service specs (counting fake, not a mock): `hold` records `holdAttempted(strategy, outcome)` exactly once for PLACED, SEAT_TAKEN and CONSTRAINT_VIOLATION; a successful `pay` records `bookingSettled(CONFIRMED)` once; a failed charge records the resulting status once; a payment that throws `ConflictException` and a transaction that rolls back record nothing; `cancel` records CANCELLED once; `expireHolds` records `bookingSettled(EXPIRED, n)` once per batch with `n > 0` and nothing for an empty run. Adapter spec with the Task 1 test reader: after the calls above the data points carry exactly the label keys `strategy`+`outcome` / `status`, and no other key.
- [ ] **Step 2: Run, expect FAIL** (`pnpm --filter @app/api test -- bookings.service otel-business`).
- [ ] **Step 3: Implement** the port, the OTel adapter (counters named per the table, `METRIC` constants) and the calls in `BookingsService` placed after `db.transaction` returns (never inside it). Inject `BUSINESS_METRICS`; `MetricsModule` is imported by `AppModule` and `WorkerModule`.
- [ ] **Step 4: Guard check by hand:** delete the `holdAttempted` call, the hold test fails; move `bookingSettled` inside the transaction, the rollback test fails. Restore.
- [ ] **Step 5: Run** the specs, `pnpm check`, `pnpm test`. **Step 6: Commit** `feat(metrics): count holds and settled bookings`.

### Task 3: Worker gauges, effect counter, in-flight queries

**Files:**

- Create: `apps/worker/src/operational-gauges.ts` + `.spec.ts`
- Modify: `apps/api/src/modules/outbox/domain/message-queue.ts` (+ `sqs-message-queue.ts`, its specs), `apps/api/src/modules/waiting-room/domain/waiting-room-store.ts` (+ Redis adapter, its spec), `apps/api/src/infrastructure/tracing/channel-spans.ts` or a sibling subscriber for in-flight queries, `apps/worker/src/queue-consumer.ts`, `apps/worker/src/worker.module.ts`, `apps/api/src/modules/outbox/index.ts`

**Interfaces:**

- Consumes: `OutboxService.oldestUnpublishedAgeSeconds(): Promise<number | null>`, `METRIC`, `BUSINESS_METRICS`.
- Produces: `MessageQueue.depth(queue: QueueName): Promise<number>` (SQS `ApproximateNumberOfMessages`; `QueueName` is the value type of `QUEUE_NAME`; the adapter resolves the DLQ URL the way it resolves the main one); `WaitingRoomStore.waitingTotal(): Promise<number>` (sum of queue lengths over events that have a waiting room, filtered in Redis/PostgreSQL, never by loading users); `OperationalGauges` provider that registers the three observable gauges from the table with async callbacks.

- [ ] **Step 1: Failing tests:** `OperationalGauges` with fake ports: reported values equal the fakes (`null` age reports 0); a rejecting port yields no observation for that gauge and one warn log carrying the error name only (no message), the other gauges still report; the gauges are not registered in the API (`AppModule` does not provide `OperationalGauges`: assert by type, not by DI scan). `QueueConsumer` spec: `effectProcessed(effect, SUCCEEDED)` once per effect that took effect, `FAILED` once for a handler that throws, nothing for a message skipped as already processed (**guard:** remove the call, test red). SQS adapter test against the emulator (`*.db.spec.ts`): `depth('booking-events-dlq')` equals the number of messages sent to it. Query counter spec: the in-flight value is 1 while a query is pending and 0 after it ended or failed (use the existing channel-span test helpers).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** the signatures above; the in-flight up-down counter is incremented on query start and decremented on end/error in the subscriber that already produces `db.query` spans, independent of `TRACING_ENABLED` (the subscription must exist when only metrics are on; with both off nothing subscribes).
- [ ] **Step 4: Run** specs (`pnpm db:up` first for `*.db.spec.ts`), `pnpm check`, `pnpm test`. **Step 5: Commit** `feat(metrics): observe outbox age, queue depth and waiting room in the worker`.

### Task 4: Prometheus in the Compose profile

**Files:**

- Create: `docker/observability/prometheus.yml`
- Modify: `docker-compose.yml`, `docker/observability/grafana/provisioning/datasources/datasources.yaml`, `docs/observability.md`

- [ ] **Step 1:** `df -h`; read the current Prometheus release and image tag from the registry; pin it.
- [ ] **Step 2: Implement.** Service `prometheus` (profile `observability`, port `127.0.0.1:9090`, volume `prometheus-data`, `--storage.tsdb.retention.time=2d`, config and rule files mounted read-only, healthcheck via the binary). Scrape jobs: `api` through `dns_sd_configs` (type `A`, name `api`, port 9464) so both replicas are scraped, `worker` static `worker:9464`. `api` and `worker` get `METRICS_ENABLED: ${METRICS_ENABLED:-false}` and `METRICS_PORT: 9464`; port 9464 is not published. Grafana gets the data source `Prometheus` (uid `prometheus`) and depends on it.
- [ ] **Step 3: Verify by hand:** `TRACING_ENABLED=true METRICS_ENABLED=true docker compose --profile observability up --build -d`, then in Prometheus `up` shows 3 targets (2 API, 1 worker) with value 1; make one booking in the UI and see `tm_holds_total` and `http_server_request_duration_seconds_count`. Record the commands in `docs/observability.md` (Start section: one command for both flags).
- [ ] **Step 4:** `pnpm check`, `docker compose config -q`; `pnpm e2e` is not affected (profile off). **Step 5: Commit** `feat(infra): Prometheus in the observability profile`.

### Task 5: Dashboards

**Files:**

- Create: `docker/observability/grafana/provisioning/dashboards/dashboards.yaml` (file provider, folder "ticketmaster"), `api.json`, `bookings.json`, `queue-outbox.json`, `waiting-room.json` in the same folder, `apps/api/src/infrastructure/metrics/observability-files.spec.ts`
- Modify: `docker-compose.yml` (mount is already the provisioning folder, check it covers `dashboards/`)

**Panels (uid fixed in the file, data source uid `prometheus`):**

- `api`: request rate, error ratio (5xx / all) and p50/p95/p99 by route template; in-flight queries `tm_db_queries_active` against a threshold line at 20 (the pool size, named in the panel description); note on the panel that the database host seen is PgBouncer.
- `bookings`: holds per second by strategy and outcome, conflicts (`SEAT_TAKEN`) ratio per strategy, settled bookings by status, expired holds rate.
- `queue-outbox`: `tm_outbox_oldest_age_seconds` (threshold at `OUTBOX_STUCK_SECONDS`, 300), `tm_queue_depth` for both queues, effect outcomes.
- `waiting-room`: `tm_waiting_room_waiting`.

- [ ] **Step 1: Failing test** in `observability-files.spec.ts`: every dashboard file parses as JSON with a unique `uid`; every metric name found in a panel `expr` (regex over `[a-z_:]+` tokens followed by `{`, `(`, `[`, space or end) exists in `EMITTED_METRIC_NAMES`, a list derived in the spec from `METRIC` plus the HTTP histogram's three suffixes; the threshold in `queue-outbox.json` equals `OUTBOX_STUCK_SECONDS`. **Guard:** rename a metric in a dashboard, the test fails.
- [ ] **Step 2: Run, expect FAIL.** **Step 3:** write the dashboards and the provider file. **Step 4:** run the spec, then open each dashboard in Grafana against the running stack from Task 4 (browser, chrome-devtools or Playwright); every panel shows data after one simulator run, none says "No data" for a metric that was exercised. **Step 5:** `pnpm check`; commit `feat(observability): provisioned dashboards`.

### Task 6: SLOs and alert rules

**Files:**

- Create: `docker/observability/alerts.yml`
- Modify: `apps/api/src/infrastructure/metrics/observability-files.spec.ts`, `docker/observability/prometheus.yml` (`rule_files`)

**SLOs (the numbers go into `docs/observability.md` in Task 7 and the rules mirror them):**

- Availability: at least 99.5 % of requests to the booking routes (`POST /api/bookings`, `POST /api/bookings/:id/payment`, `POST /api/bookings/:id/cancel`) answer with a status below 500, over 30 days.
- Latency: p95 of the hold route at most 500 ms, of the payment route at most 1 s.

**Rules:** `BookingErrorRatioHigh` (5xx ratio of the booking routes above 5 % for 5 min, severity page), `HoldLatencyHigh` and `PaymentLatencyHigh` (p95 above target for 10 min), `OutboxStuck` (`tm_outbox_oldest_age_seconds > 300` for 1 min), `DeadLetterQueueNotEmpty` (`tm_queue_depth{queue="booking-events-dlq"} > 0` for 1 min), `ScrapeTargetDown` (`up == 0` for 1 min). Each rule has `summary` and `runbook` annotations (`docs/observability.md#alerts`).

- [ ] **Step 1: Failing tests** added to `observability-files.spec.ts`: `alerts.yml` parses (use the `yaml` package if already a dependency, otherwise read the dependency list first and add it as a dev dependency with the reason in the commit); every metric name in a rule `expr` is emitted; `OutboxStuck` threshold equals `OUTBOX_STUCK_SECONDS`; every rule has both annotations. **Guard:** change the threshold to 301, the test fails.
- [ ] **Step 2: Run, expect FAIL.** **Step 3:** write the rules. **Step 4:** `docker run --rm --entrypoint promtool -v "$PWD/docker/observability:/c:ro" <prometheus image from Task 4> check rules /c/alerts.yml` passes; with the stack running, stop the worker (`docker compose stop worker`) and see `ScrapeTargetDown` pending then firing under Alerts in Prometheus, then start it again. **Step 5:** `pnpm check`; commit `feat(observability): SLO alert rules`.

### Task 7: Documentation and state

**Files:** `docs/observability.md`, `docs/BACKLOG.md`, `docs/docs-map.json` (entries for `apps/api/src/infrastructure/metrics/` and `apps/worker/src/operational-gauges.ts`), `README.md` only if it lists the observability stack.

- [ ] **Step 1:** `docs/observability.md`: sections "Metrics" (table of instruments with labels and who emits them, the cardinality rule, the scrape port), "Dashboards", "SLOs" (the numbers above), "Alerts" (rule, condition, what to check first). Start section shows the one command that sets both flags. No test counts, relative links.
- [ ] **Step 2:** BACKLOG: slice B state, deviations (the four above), open points (no alert delivery, retention 2 days, `tm_db_queries_active` is in-flight queries and not pool usage). Replace the "Next" paragraph: slices C and D remain.
- [ ] **Step 3:** `pnpm check`, `pnpm test`; commit `docs: slice B state, SLOs and alerts of phase 3`.

### Final gate (not a task of the plan list above)

One whole-branch review of the slice with `pruefer` on the strongest model (new listening port and its exposure, label cardinality, double counting across API replicas, rollback paths of the counters), then `gh run list --branch main --limit 1` after the push and fix a red run first. Stop and report: state, deviations, open points. Slice C starts in a fresh session.

## Ledger

Per task: duration and subagent tokens (from the Agent result) in a table in the final report, plus one sum row.

## Self-review notes

- Spec coverage: RED from HTTP instrumentation (1), business counters through one port (2), holds/bookings/conflicts/expiries (2), outbox age, queue depth, DLQ size, waiting room length (3), pool saturation (3, deviation), four dashboards (5), alert rules for SLOs, stuck outbox, DLQ (6), `docs/observability.md` with metric table checked by a test (5, 6, 7). The "hold counter" guard is Task 2 step 4; label-set and dashboard/rule name tests are Tasks 2, 5, 6.
- The spec's "metric table checked by a test that every named metric exists": the table lives in the docs and the dashboards/rules are checked against the code dictionary; add to Task 7 a spec assertion that every `METRIC` value appears in `docs/observability.md`.
