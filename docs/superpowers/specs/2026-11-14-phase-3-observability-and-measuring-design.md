# Phase 3: Observability and measuring, design

Scope and Definition of Done come from [PLAN.md](../../PLAN.md#phase-3-observability-and-measuring);
this document fixes the design decisions. Rules: [AGENTS.md](../../../AGENTS.md). Phase 2 design:
[phase 2 spec](2026-11-13-phase-2-async-and-scaling-design.md).

## Outcome

One booking can be followed from the browser request through the API, PostgreSQL, Redis, the outbox,
the queue and the worker as a single trace, and every log line of it carries that trace ID. RED
metrics per route and business metrics are scraped, shown on provisioned Grafana dashboards and
guarded by SLO alerts. An admin can read who did what in an audit log view. k6 scenarios put numbers
on the system, and a cache for the public event pages has a measured effect.

Out of scope for phase 3: threat model, container hardening and row-level security (phase 4),
anything that needs a public server, including the read-only public Grafana (phase 5), alert
delivery (email, chat) beyond Grafana's own alert state, front-end tracing beyond propagating the
trace header from the browser (see Decisions).

## Decisions

| Topic           | Decision                                                                                                                                            | Rejected                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Work split      | One spec, one plan per slice (A to D), stop and report after each slice                                                                             | One plan for the phase                                               |
| Order           | Tracing and logs (A), metrics, dashboards and alerts (B), audit log (C), k6 and cache (D)                                                           | Metrics first: the simulator's trace link and log correlation need A |
| Instrumentation | OpenTelemetry JS SDK with auto-instrumentation for HTTP, `pg`, `ioredis` and AWS SDK, started by a preload module before the app imports anything   | Hand-written spans everywhere; vendor agents                         |
| Manual spans    | Only where auto-instrumentation cannot see: outbox relay send, consumer handler per effect, hold strategies (one span per strategy call)            | A span per function                                                  |
| Queue context   | The relay writes `traceparent` into the SQS message attributes; the consumer extracts it and links its span to the producing trace                  | Putting the context in the message body (contract change)            |
| Browser         | The web app sends no spans; Caddy and the API accept an incoming `traceparent` and the API starts the trace at the edge                             | OTel Web SDK (bundle size is already over budget, see backlog)       |
| Export          | Traces: OTLP over HTTP straight to Tempo. Metrics: a Prometheus scrape endpoint on API and worker. No collector unless a pipeline step needs one    | A collector by default (one more container)                          |
| Logs            | pino keeps writing JSON lines to stdout; `trace_id` and `span_id` are added from the active span; Loki reads the container logs                     | Shipping logs through OTLP                                           |
| Stack           | Tempo, Loki, Prometheus, Grafana in the Compose profile `observability`; the default stack and `pnpm e2e` do not start it                           | Always on (four more containers for every `docker compose up`)       |
| Provisioning    | Data sources, dashboards (JSON in the repo) and alert rules are files under `docker/observability/`, loaded by Grafana at start                     | Click-ops in the UI                                                  |
| Metrics         | RED per route from the HTTP instrumentation; business metrics (holds by outcome, bookings by status, conflicts, expired holds, waiting room length) | Per-user labels (cardinality, personal data)                         |
| SLOs            | Availability and p95 latency of the booking routes, written down with their numbers in `docs/observability.md`; alert rules mirror them             | Alerts without a stated objective                                    |
| Audit log       | Table `audit_log` (append-only: no update or delete grant path in code, one insert function), written in the transaction of the audited change      | Logging the audit trail to pino only; event sourcing                 |
| Audit content   | Actor ID, action (dictionary in `packages/shared`), subject type and ID, time, request ID. IDs only, no names, addresses or payloads                | Free-text details, request bodies                                    |
| Audit view      | `GET /api/audit-log` (admin only, filter by action and actor, keyset pagination) and an admin page with the four UI states                          | Offset pagination (unstable on an append-only table)                 |
| Load tests      | k6 scripts in `scripts/k6/`, run against the Compose stack; scenarios and results in `docs/load-tests.md` with date, hardware and numbers           | Results without the hardware; load tests in CI (noisy)               |
| Cache           | Redis cache for the public event list and event detail; seat status stays uncached; invalidated on any change to the event or its seats             | HTTP cache in Caddy (coarse invalidation, no hit-rate metric)        |
| Cache proof     | k6 run before and after, hit ratio as a metric, numbers in `docs/load-tests.md`                                                                     | Claiming an effect without a measurement                             |
| Libraries       | `@opentelemetry/*` packages, `prom-client` only if the OTel metrics path cannot expose what Prometheus needs; versions are read from the registry   | Pinning versions from memory (AGENTS rule 9)                         |

## Slice A: tracing and correlated logs

The SDK is initialised in a preload module of `apps/api` and `apps/worker` (config through the
config module, never `process.env` directly; the endpoint and an on/off switch are env variables
listed in `.env.example`). With the switch off the apps behave as today and tests run without any
exporter. The relay adds `traceparent` to each message; the consumer continues it. pino's mixin adds
`trace_id` and `span_id`. The simulator page links a finished run to its trace in Grafana (the link
is built from a configured base URL and hidden when it is unset). The Compose profile starts Tempo,
Loki and Grafana with the data sources provisioned.

**Tests:** an in-memory exporter shows one trace across a request, the outbox row and the consumer
handler (same trace ID); a message without `traceparent` still gets handled (new trace); a log line
inside a request carries the trace ID; with the switch off no exporter is created. **Guards:** the
relay test fails if the attribute is not written; the consumer test fails if the context is not
extracted.

## Slice B: metrics, dashboards, alerts

Prometheus scrapes API and worker. RED metrics come from the HTTP instrumentation, business metrics
are counters and gauges incremented in the application layer through one small port, so the domain
stays free of I/O. Dashboards: API (RED, saturation of the pool), bookings (holds, conflicts,
confirmations, expiries), queue and outbox (age of the oldest unpublished row, queue depth, DLQ
size), waiting room. Alert rules for the SLOs and for a stuck outbox and a non-empty DLQ.
`docs/observability.md` lists metrics, SLOs and alerts (the metric table is generated by
`pnpm docs:generate` if it can be derived from code, otherwise written by hand and checked by a test
that every named metric exists).

**Tests:** each business metric moves exactly once per event (hold placed, conflict, confirm,
expiry); label sets contain no user or booking ID; provisioned dashboard and rule files parse and
reference only existing metric names. **Guard:** removing the increment in the hold path turns the
hold-counter test red.

## Slice C: audit log

Migration (drizzle-kit) for `audit_log`; a domain-side port `AuditLog.record` with one Drizzle
adapter that takes the surrounding transaction. Audited actions: booking held, paid, cancelled,
event created, strategy switched, waiting-room settings changed, simulation started. Admin route and
page as in the decisions table. The table is an expand step only; the append-only rule is recorded in
`docs/data-model.md`.

**Tests:** each audited action writes exactly one row in the same transaction (a rolled-back change
leaves no row); the route answers 403 for customer and organizer and for a missing token; keyset
pagination returns every row once under concurrent inserts; the page shows empty, loading, error
with retry and pending. **Guard:** moving the insert outside the transaction turns the rollback test
red.

## Slice D: k6 and the event page cache

k6 scenarios: browse (list and detail), booking flow (hold, pay), rush on one seat per strategy, and
the waiting room. They run through the Compose stack, thresholds are stated in the script, results
and hardware go into `docs/load-tests.md`. Baseline first, then the cache: a cache-aside module for
the public event list and detail with a short TTL as a safety net and explicit invalidation on
event or seat-configuration change; cache hits and misses are metrics (slice B), the hit ratio is on
a dashboard. Seat status and anything user-owned never go through the cache.

**Tests:** a hit does not query PostgreSQL (counting adapter, not a mock); a change to the event
invalidates the entry; a Redis failure falls through to the database and is logged with its ID only
(fail fast does not mean the page goes down for a cache outage, this one path is the explicit
exception and is stated in the code); user-owned data is never cached. **Guard:** removing the
invalidation turns the invalidation test red.

## Execution

Each slice gets its own plan under `docs/superpowers/plans/`, executed with `umsetzer` subagents;
review only for the tasks that touch auth (audit route), data loss or transactions (audit insert)
and the context propagation through the queue (A); one final review per slice. Docs change with the
code (README, `docs/observability.md`, `docs/load-tests.md`, `docs/data-model.md`, `docs/api/`,
docs-map entries for `docker/observability/` and `scripts/k6/`). Free disk space is checked with
`df -h` before pulling the stack images (about 20 GiB free at the start of the phase). After each
slice: stop, report, update [BACKLOG.md](../../BACKLOG.md).

## Risks

- **Auto-instrumentation under ESM.** NestJS runs as native ESM here; the OTel hooks need the
  loader registered before the first import. Mitigation: the first task of slice A is a spike that
  proves a trace through `pg` and `ioredis` before anything depends on it.
- **PgBouncer and spans.** Traces see the pooler as the database host, not the PostgreSQL server;
  accepted and noted on the dashboard.
- **Memory.** Four more containers. Mitigation: the profile; the budget goes into the phase 5 ADR.
- **Metric cardinality.** Route labels use the route template, never the URL. Mitigation: a test on
  the label set.
- **Load test numbers depend on the machine.** Mitigation: every result states the hardware and the
  run is never a CI gate.
- **Audit log growth.** No retention yet; listed in the backlog with the outbox rows.
