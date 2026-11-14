# Observability

A booking crosses the API, PostgreSQL, Redis, the outbox row, the queue and the worker. With tracing
on, one request is one trace across all of them, and every log line written inside it carries the
`trace_id`. The decision and the span rules are in
[ADR 0007](adr/0007-tracing-with-opentelemetry.md). Tracing is off by default and in every test
project; the stack below is local only and part of no deployment.

## Start

The four services (Tempo, Loki, Alloy, Grafana) live in the Compose profile `observability`. The
default `docker compose up` and `pnpm e2e` start none of them and never trace.

```sh
TRACING_ENABLED=true docker compose --profile observability up --build -d
docker compose --profile observability down   # stop it again (add -v to drop the stored traces and logs)
```

| Service | Host port (127.0.0.1) | Role                                                                                            |
| ------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| grafana | 3000                  | UI; login `admin`, password `GRAFANA_ADMIN_PASSWORD` (default `admin`); anonymous access is off |
| tempo   | 3200                  | trace store and query API; OTLP/HTTP on 4318 inside the network                                 |
| loki    | 3100                  | log store and query API                                                                         |
| alloy   | none                  | reads the container logs and ships them to Loki                                                 |

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
