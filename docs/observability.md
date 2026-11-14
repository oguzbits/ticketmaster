# Observability

A booking crosses the API, PostgreSQL, Redis, the outbox row, the queue and the worker. With tracing
on, one request is one trace across all of them, and every log line written inside it carries the
`trace_id`. The decision and the span rules are in
[ADR 0007](adr/0007-tracing-with-opentelemetry.md). Tracing is off by default and in every test
project; the stack below is local only and part of no deployment.

## Start

The five services (Tempo, Loki, Alloy, Prometheus, Grafana) live in the Compose profile `observability`. The
default `docker compose up` and `pnpm e2e` start none of them, never trace and serve no metrics.

```sh
TRACING_ENABLED=true METRICS_ENABLED=true docker compose --profile observability up --build -d
docker compose --profile observability down   # stop it again (add -v to drop the stored traces and logs)
```

| Service    | Host port (127.0.0.1) | Role                                                                                            |
| ---------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| grafana    | 3000                  | UI; login `admin`, password `GRAFANA_ADMIN_PASSWORD` (default `admin`); anonymous access is off |
| tempo      | 3200                  | trace store and query API; OTLP/HTTP on 4318 inside the network                                 |
| loki       | 3100                  | log store and query API                                                                         |
| prometheus | 9090                  | metric store and query UI; scrapes the API replicas and the worker every 10 s, keeps 2 days     |
| alloy      | none                  | reads the container logs and ships them to Loki                                                 |

`api` and `worker` send spans to `http://tempo:4318` (`TRACING_OTLP_ENDPOINT` in the Compose file)
when `TRACING_ENABLED=true`. Their Docker command is
`node --import ./dist/tracing.preload.js dist/main.js`; the preload registers the ESM hooks before the
app imports Express and does nothing when tracing is off. Without Tempo running, tracing on costs a
request nothing: spans are dropped when the export fails.

The Grafana data sources are provisioned from `docker/observability/grafana/provisioning/`:

- `tempo` (uid `tempo`): "Related logs" on a trace runs
  `{service=~"api|worker"} | json | trace_id="<id>"` on Loki, with the time range widened by a second
  before and two seconds after the trace.
- `loki` (uid `loki`): a derived field on `trace_id` adds an "Open trace" link to every log line that
  has one.
- `prometheus` (uid `prometheus`): the metrics of the next section.

## What a trace contains

| Service               | Spans                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ticketmaster-api`    | the HTTP server span named after the route template (`POST /api/bookings/:id/payment`), `db.query`, `redis.command`, `booking.hold.strategy` on a hold          |
| `ticketmaster-worker` | `outbox.send` (the relay, a child of the request), `<queue> send`, `queue.process`, one `queue.effect` per effect (mail, ticket), their `db.query` and S3 spans |

The outbox row stores the request's `traceparent`, the relay continues it, and the queue message
carries the send span's context, so a payment, the relay and both effects share one trace ID. A hold
and a payment are two requests and so two traces.

What is not in the data, on purpose: SQL parameters, Redis keys and arguments, error messages (a
failed span carries the error name only), client address, user agent and query string. Not traced:
the browser (it sends no `traceparent`, the API's server span is the root), the seat stream
(`text/event-stream` requests), the health routes (`/health/*`, polled by container health checks)
and the queue long poll when it receives nothing. Two traces are always present at start and are
not requests: `SQS.GetQueueUrl` of the API and of the worker (the queue lookup at boot).
PgBouncer sits between the processes and PostgreSQL, so the `server.address` of a `db.query` span is
the pooler.

Outgoing client spans keep `url.full`. That is safe only because no outgoing URL carries a query
string (checked: Keycloak, SQS and S3 paths). If one ever does, strip `url.full` in the span
processor in `apps/api/src/infrastructure/tracing/tracing.ts`.

## Trace link of a simulator run

A run started with tracing on stores the `traceparent` of its start request
(`simulation_runs.traceparent`). The worker takes the run from the Redis stream and runs it inside
that trace (a `simulation.run` span with the run ID, then the `booking.hold.strategy` and
`db.query` spans of every buyer), so the request and the run are one trace. The API adds
`traceUrl` to a run: the Grafana Explore link on the `tempo` data source with the trace ID as the
query, over the time of the run. The simulator page shows it as a "Trace" link in the table of
finished runs; it opens in a new tab.

`traceUrl` is null, and the page shows no link and no column, when `GRAFANA_URL` is not set (the
Compose file sets it to `http://localhost:3000`, the Grafana of this profile; the value is the
address of Grafana as the admin's browser reaches it), when tracing was off at the start, and for
runs older than the column. A run writes about seven spans per buyer attempt into the one trace (a
run of 50 buyers and 110 attempts gave 778 spans); Grafana shows them, a run of the maximum size is large enough to hit
Tempo's per-trace size limit, and the trace is then cut off.

## Metrics

Prometheus-format metrics are off by default and in every test project (`METRICS_ENABLED=false`).
Start the profile with `TRACING_ENABLED=true METRICS_ENABLED=true` (the command in
[Start](#start)); the two flags are independent, but the profile needs both. With
`METRICS_ENABLED=true` the API and the worker each serve `/metrics` from their own listener:

| Variable          | Default     | Meaning                                                                                   |
| ----------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `METRICS_ENABLED` | `false`     | starts the meter provider and the listener                                                |
| `METRICS_PORT`    | `9464`      | port of `/metrics`; a port that cannot be bound stops the process                         |
| `METRICS_HOST`    | `127.0.0.1` | interface of the listener; Compose sets `0.0.0.0` so the scraper can reach it (see below) |

Port 9464 is never published to the host and the output holds no personal data. Two processes on
one host need different ports. Either flag makes the preload register the HTTP instrumentation,
once. Prometheus (`docker/observability/prometheus.yml`) scrapes port 9464 inside the Compose
network: the job `api` resolves the service name `api` through DNS (`dns_sd_configs`, type `A`), so
each replica is a target, and the job `worker` scrapes `worker:9464`.
`http://localhost:9090/targets` shows three targets, all up, when the stack was started with
`METRICS_ENABLED=true` (without it every target is down). The decision and the spike are in
[ADR 0008](adr/0008-metrics-with-opentelemetry.md).

| OpenTelemetry name             | Prometheus series                                                 | Kind             | Labels                                                                      | Emitted by                                                 |
| ------------------------------ | ----------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `http.server.request.duration` | `http_server_request_duration_bucket`, `_sum`, `_count` (seconds) | histogram        | `http_request_method`, `http_route`, `http_response_status_code`            | API (HTTP instrumentation)                                 |
| `tm.holds`                     | `tm_holds_total`                                                  | counter          | `strategy`, `outcome`                                                       | API and the simulator in the worker, once per hold attempt |
| `tm.bookings.settled`          | `tm_bookings_settled_total`                                       | counter          | `status`                                                                    | API (payment, cancel), worker (expiry job)                 |
| `tm.queue.effects`             | `tm_queue_effects_total`                                          | counter          | `effect`, `outcome`                                                         | worker                                                     |
| `tm.cache.requests`            | `tm_cache_requests_total`                                         | counter          | `cache` (`events.list`, `events.detail`), `result` (`HIT`, `MISS`, `ERROR`) | API                                                        |
| `tm.db.queries.active`         | `tm_db_queries_active`                                            | up-down counter  | none                                                                        | API, worker                                                |
| `tm.outbox.oldest_age`         | `tm_outbox_oldest_age` (seconds, 0 when no row waits)             | observable gauge | none                                                                        | worker only                                                |
| `tm.queue.depth`               | `tm_queue_depth`                                                  | observable gauge | `queue` (`booking-events`, `booking-events-dlq`)                            | worker only                                                |
| `tm.waiting_room.waiting`      | `tm_waiting_room_waiting`                                         | observable gauge | none                                                                        | worker only; users waiting in all rooms                    |

The exporter turns the dots into underscores, adds `_total` to counters and never appends the unit.

`tm_holds_total` also counts the hold attempts of the simulator, which runs in the worker, so the
`Bookings` dashboard mixes simulator load into the customer holds while a run is going.

The HTTP instrumentation also exposes `http_client_request_duration_*` (outgoing calls, labelled by
server address and bounded by the few hosts the services call). No dashboard or alert reads it.

**Cardinality rule.** A label value comes from a closed set: the route template, a strategy, a
booking status, a hold outcome, an effect, a queue name. No ID of a user, booking, event, seat or
message and no raw URL is ever a label. `http_route` is the route template
(`/api/bookings/:id/payment`), `/api*path` for an unknown path below `/api`, and `UNMATCHED` for any
other request no route matched, so a URL never becomes a series. Health probes, event streams and
the scrape itself are not counted.

**Counters.** `tm_holds_total` and `tm_bookings_settled_total` are increased only after the database
transaction committed, so a rolled-back or refused action counts nothing. Hold outcomes are
`PLACED`, `SEAT_TAKEN` and `CONSTRAINT_VIOLATION`. A booking is settled as `CONFIRMED` or `CANCELLED`
after a payment, `CANCELLED` after a cancel and `EXPIRED` by the expiry job, once per batch.
`tm_queue_effects_total` counts one per queue effect that took effect (`SUCCEEDED`) or whose handler
threw (`FAILED`); a message handled before counts nothing.

**Cache.** `tm_cache_requests_total` counts one per event-page read that went to Redis: `HIT` served the stored value, `MISS` loaded from PostgreSQL (an empty key, a value that is not JSON or one that no longer matches its schema), `ERROR` means a Redis call failed or did not answer within 250 ms (reads, writes after a load and invalidations alike) and the read fell through to PostgreSQL. A cache with `EVENT_CACHE_TTL_SECONDS=0` counts nothing. The labels name the cache, never an event.

**Gauges.** Outbox age, queue depth and waiting room are registered by the worker only, so replicas
of the API do not report shared state twice. A gauge whose source fails or does not answer within 3
seconds is left out of that scrape and logged by error name, never reported as 0 or repeated with its
last value (the exporter writes gauges as deltas for this); [GaugeSourceMissing](#alerts) watches
for that. `tm_db_queries_active` needs only `METRICS_ENABLED` and is the number of database queries
in flight, not the pool usage: postgres.js exposes no pool statistics. The dashboard compares it with
the pool size of 20.

## Dashboards

Grafana loads four dashboards into the folder `ticketmaster` at start
(`docker/observability/grafana/provisioning/dashboards/`, data source `prometheus`; the files are
read-only in the UI, change the JSON): `API` (request rate, 5xx ratio and p50/p95/p99 per route
template, queries in flight against the pool size of 20; the database host the services see is
PgBouncer; the event cache hit ratio, `HIT` over `HIT` and `MISS` of `tm_cache_requests_total`),
`Bookings` (holds per second by strategy and outcome, `SEAT_TAKEN` ratio per strategy, settled bookings by status, expired holds), `Queue and outbox` (age of the oldest outbox row with a
line at `OUTBOX_STUCK_SECONDS`, depth of the booking queue and its dead-letter queue, queue effects
by outcome) and `Waiting room`. A panel shows a gap, not 0, while the process that reports its
metric is down; a counter series starts with its first event, so a rate panel such as expired holds
shows no data until the counter has increased twice. `observability-files.spec.ts` checks that every
metric a panel reads is one the services emit, that the two threshold lines equal
`OUTBOX_STUCK_SECONDS` and the pool size, and that every instrument is named in this document.

## SLOs

The booking routes are `POST /api/bookings` (hold), `POST /api/bookings/:id/payment` and
`POST /api/bookings/:id/cancel`.

| Objective    | Target                                                         |
| ------------ | -------------------------------------------------------------- |
| Availability | 99.5 % of booking-route requests answer below 500 over 30 days |
| Hold latency | p95 of the hold route at most 500 ms                           |
| Payment      | p95 of the payment route at most 1 s                           |

The rules in `docker/observability/alerts.yml` encode them as short-window checks, not as a 30-day
budget: the error ratio over 5 minutes above 5 % pages, and each p95 over 5 minutes above its limit
warns after 10 minutes. `observability-files.spec.ts` keeps the thresholds equal to these numbers.

## Alerts

Prometheus evaluates `docker/observability/alerts.yml` every evaluation interval and shows the state
of each rule at `http://localhost:9090/alerts`. Every rule links here from its `runbook` annotation.
The rules are Prometheus rule files, not Grafana-managed rules.

| Alert                     | Severity | Condition (for)                                                                           | Check first                                                                                                                                                                                                                       |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BookingErrorRatioHigh`   | page     | 5xx share of the three booking routes above 5 % over 5 min (5 min)                        | The `API` dashboard: which route template and status. Then the API log lines of that time in Loki and a failing request's trace in Tempo; a failing `db.query` or `redis.command` span names the dependency.                      |
| `HoldLatencyHigh`         | warning  | p95 of `POST /api/bookings` above 500 ms over 5 min (10 min)                              | The `API` dashboard: queries in flight against the pool size of 20 (saturation), then the `Bookings` dashboard for the strategy in use; open a slow request's trace and read its `booking.hold.strategy` and `db.query` spans.    |
| `PaymentLatencyHigh`      | warning  | p95 of `POST /api/bookings/:id/payment` above 1 s over 5 min (10 min)                     | The same panels, then the spans of a slow payment trace: the transaction and the outbox write happen in the request, the effects run later in the worker.                                                                         |
| `OutboxStuck`             | warning  | maximum of `tm_outbox_oldest_age` over 5 min above `OUTBOX_STUCK_SECONDS` (300 s) (1 min) | Is the worker up (`ScrapeTargetDown`)? Then the worker log of the outbox relay and the reachability of SQS; the `Queue and outbox` dashboard shows the age and the queue depth.                                                   |
| `DeadLetterQueueNotEmpty` | warning  | maximum of `tm_queue_depth{queue="booking-events-dlq"}` over 5 min above 0 (1 min)        | `tm_queue_effects_total{outcome="FAILED"}` on the `Queue and outbox` dashboard for the failing effect, then the worker log line and trace of that message.                                                                        |
| `GaugeSourceMissing`      | warning  | the worker is up but reported no outbox age or no dead-letter depth for 1 min (2 min)     | The worker log for the gauge error (PostgreSQL or SQS unreachable, or no answer within 3 s). Until fixed, `OutboxStuck` and `DeadLetterQueueNotEmpty` cannot fire.                                                                |
| `ScrapeTargetDown`        | warning  | `up == 0` for any target (1 min)                                                          | `http://localhost:9090/targets` for the target and its error. Every target is down when the stack was started without `METRICS_ENABLED=true`. A container that stopped is not down here, it is gone: see the two API rules below. |
| `ApiAllReplicasGone`      | page     | no API target answers (`absent(up{job="api"} == 1)`) (1 min)                              | `docker compose ps api` and the API container log; the booking alerts are blind and requests fail while this fires.                                                                                                               |
| `ApiReplicaMissing`       | warning  | fewer than 2 API targets answer (1 min)                                                   | `docker compose ps api` for the replica that exited or restarts. The 2 is `deploy.replicas` of the `api` service in `docker-compose.yml`; change both together (the spec checks it).                                              |

`GaugeSourceMissing` exists because a gauge whose source is down is absent from the scrape instead
of 0, so the two rules on worker gauges would go silent. It requires `up{job="worker"} == 1`, so a
worker that is down is `ScrapeTargetDown` alone. A target that is down for a few seconds during
start shows as pending first.

`OutboxStuck` and `DeadLetterQueueNotEmpty` judge the maximum of the last 5 minutes, because a gauge
whose source times out is left out of a scrape and a plain comparison would restart its `for` on
every gap; the price is that they resolve up to 5 minutes after the cause is gone. A gauge that is
gone for a whole minute is `GaugeSourceMissing`.

`ScrapeTargetDown` cannot see a stopped or crash-looping API container: Docker DNS stops returning
its address, `dns_sd_configs` drops the target, and no `up == 0` series is written. That is why
`ApiAllReplicasGone` and `ApiReplicaMissing` count the answering targets instead.

Known limits:

- **No burn-rate rules.** The 30-day availability budget is not computed; the 5 % short-window rule
  is its coarse stand-in.
- **No alert delivery.** There is no Alertmanager, mail or pager; an alert is visible in the
  Prometheus UI only.
- **Gauges without an alert:** `tm_waiting_room_waiting` and `tm_db_queries_active`; they are on
  the dashboards only.
- **Retention is 2 days** (`--storage.tsdb.retention.time`), so a 30-day window cannot be queried
  locally.
- **`tm_db_queries_active` is in-flight queries, not pool usage.** The 20 on the `API` dashboard is
  the pool size of one API process, a hint, not a measured saturation.
- **`tm_waiting_room_waiting` keeps a queue counted for up to 24 hours** after an event drops its
  waiting room, until the Redis key of that queue expires.

## Check it by hand

A repeatable check, not a CI job: it needs the profile. Stop any `pnpm dev` worker first, or it
relays the outbox rows without tracing and takes queue messages from the container worker.

1. Start the stack as above, log in as a customer (`POST /api/demo-login` with `{"role":"customer"}`),
   hold a seat of a public event (`POST /api/bookings`) and pay it (`POST /api/bookings/:id/payment`
   with an `Idempotency-Key` header).
2. The `trace_id` of the payment request is in the API log line `request completed`, and in the
   worker's `confirmation mail ... sent` line. Fetch the trace from Tempo:

   ```sh
   curl -s "http://localhost:3200/api/traces/<trace_id>"
   ```

   The answer holds spans of both `ticketmaster-api` (server, `db.query`, `redis.command`) and
   `ticketmaster-worker` (`outbox.send`, `queue.process`, two `queue.effect`) under one trace ID.
   To list recent traces: `curl -s -G http://localhost:3200/api/search --data-urlencode 'q={ resource.service.name =~ "ticketmaster.*" }'`.

3. Ask Loki for the lines of that trace, once per service; both return lines:

   ```sh
   curl -s -G http://localhost:3100/loki/api/v1/query_range \
     --data-urlencode 'query={service="api"} | json | trace_id="<trace_id>"'
   curl -s -G http://localhost:3100/loki/api/v1/query_range \
     --data-urlencode 'query={service="worker"} | json | trace_id="<trace_id>"'
   ```

4. In Grafana (http://localhost:3000, Explore, data source Tempo, query type TraceQL, paste the
   trace ID): the waterfall shows both services; "Related logs" opens the Loki lines of the trace;
   in Explore with Loki, the log details of a line have an "Open trace" link back.

## Risks and limits

- **Alloy mounts the Docker socket** (`/var/run/docker.sock`, `:ro`). The flag only protects the
  socket file: anything that can connect to it can still call the whole Docker API, so the Alloy
  container, which runs as root, has root-level reach over the host's Docker (it can list, read and
  start containers). Alloy itself only reads container logs, but a flaw in it, or in its config,
  would not stop there. That is why the profile is local only and part of no deployment; do not run
  it on a shared machine. Alloy discovers only the containers of the Compose project
  `ticketmaster-klon` (the e2e stack has another project name and is not shipped).
- Loki has no health check (its image has no shell); Alloy retries its pushes until Loki is up.
- Traces and logs have no retention limit and live in the volumes `tempo-data`, `loki-data` and
  `grafana-data`; `docker compose --profile observability down -v` removes them (and the other
  volumes of the project, including the database).
- Alloy turns `level` into a Loki label; `trace_id` and `span_id` stay in the line, because one
  value per request would explode the label index.
