# 0008: Metrics with OpenTelemetry and the Prometheus exporter

- Status: accepted
- Date: 2026-11-14

## Context and problem statement

Prometheus should scrape RED metrics (rate, errors, duration) per route and a handful of business
metrics from the API and the worker. Both are native ESM NestJS applications that already start an
OpenTelemetry SDK, assembled by hand, from a preload ([ADR 0007](0007-tracing-with-opentelemetry.md)).
Which pieces produce the request histogram, who serves `/metrics`, and how do the two processes
expose it without a second code path?

## Decision drivers

- The worker has no HTTP server, so whatever serves `/metrics` must run without Nest.
- The route label must be a template (`/api/bookings/:id/payment`), never a raw URL: one series per
  URL would be a cardinality leak, and an ID in a label is a personal-data leak (invariant 6).
- Metrics off (the default and every test project) is inert: no provider, no listener.
- Invariant 5: no `OTEL_*` variable is read; options come from the validated config.
- Verified on the installed packages, not assumed (invariant 9).

## Considered options

1. `@opentelemetry/sdk-metrics` `MeterProvider` with `@opentelemetry/exporter-prometheus`, fed by
   the HTTP instrumentation that tracing already registers; assembled by hand.
2. `prom-client` with a `/metrics` route in Nest.
3. `@opentelemetry/sdk-node` (`NodeSDK`).

## Decision outcome

Chosen: option 1. The exporter serves `/metrics` from its own `http` listener on `METRICS_PORT`
(default 9464), so API and worker behave the same and the app's port never carries it.

### Pinned versions

Read from the registry; both peer on `@opentelemetry/api >=1.10.0 <1.11.0` (installed: 1.10.0) and
depend on `core`/`resources` 3.1.1 (installed).

| Package                              | Version |
| ------------------------------------ | ------- |
| `@opentelemetry/sdk-metrics`         | 3.1.1   |
| `@opentelemetry/exporter-prometheus` | 0.301.2 |

### Spike result

Run against `@opentelemetry/instrumentation-http` 0.301.2 and `instrumentation-express` 0.73.0 on
Node v26.12.0 with Express 5.3.0.

- **(a) The HTTP instrumentation records `http.server.request.duration`** (unit `s`) as soon as a
  global `MeterProvider` exists. It needs a context manager for the route (below), no tracer
  provider.
- **(b) The metric carries the route template** (`http.route`) for a matched Express route, in a
  plain Express app and in a Nest app with a global prefix. The ESM hooks must be registered before
  the app imports Express (`import-in-the-middle/register-hooks.mjs`, as the preload does); a spec
  has to register them too. So the Express `res.on('finish')` fallback of the plan is not needed.
  Three gaps and how they are closed:
  1. A request that no route matched has **no** `http.route` attribute. A view on the instrument
     (`REQUEST_HISTOGRAM_VIEW`) sets `http.route = 'UNMATCHED'` when it is missing and keeps only
     `http.request.method`, `http.route` and `http.response.status_code` (the instrument also
     writes `url.scheme` and `network.protocol.version`; `error.type` is dropped, the status says
     the same).
  2. Under the global prefix Nest registers a catch-all, so an unknown path below `/api` is
     labelled `/api*path` (also bounded); an unknown path elsewhere is `UNMATCHED`. A request with a
     UUID in the path never puts it into a label (pinned by `metrics.spec.ts`).
  3. The metrics API has no proxy provider (the trace API has): an instrumentation registered
     before the meter provider was set keeps a no-op meter. The preload starts tracing first, so
     `startMetrics` hands the provider to the registered instrumentations (`useMeterProvider`).
- The Express route needs the context manager that tracing used to set. It moved, with the
  instrumentation registration, into `acquireInstrumentation()`: reference-counted, so with both
  flags on the HTTP, Express and AWS instrumentations are registered once and the last shutdown
  unregisters them. Spans stay no-ops without a tracer provider.
- The HTTP server's metrics skip what tracing skips (event streams, `/health/*`) and the scrape of
  `/metrics` itself. The HTTP instrumentation also records `http.client.request.duration`
  (outgoing calls, labelled by server address); it is bounded by the hosts the services call and is
  left as is.
- **(c) Prometheus names** (exporter 0.301.2). The exporter appends `_total` to counters but **does
  not append the unit**: `_seconds` is never written (the unit appears as `# UNIT`). The table of
  the plan is corrected accordingly. Resource attributes go to `target_info`; the scope labels
  (`otel_scope_name`, `otel_scope_version`) are switched off (`withoutScopeInfo`).

  | OTel name                      | Prometheus name                                         | Labels                                                           |
  | ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------- |
  | `http.server.request.duration` | `http_server_request_duration_bucket`, `_sum`, `_count` | `http_request_method`, `http_route`, `http_response_status_code` |
  | `tm.holds`                     | `tm_holds_total`                                        | `strategy`, `outcome`                                            |
  | `tm.bookings.settled`          | `tm_bookings_settled_total`                             | `status`                                                         |
  | `tm.queue.effects`             | `tm_queue_effects_total`                                | `effect`, `outcome`                                              |
  | `tm.db.queries.active`         | `tm_db_queries_active` (gauge)                          | none                                                             |
  | `tm.outbox.oldest_age`         | `tm_outbox_oldest_age` (gauge, seconds)                 | none                                                             |
  | `tm.queue.depth`               | `tm_queue_depth` (gauge)                                | `queue`                                                          |
  | `tm.waiting_room.waiting`      | `tm_waiting_room_waiting` (gauge)                       | none                                                             |

  The first row was observed on a real scrape; the others were checked on a scratch provider (a
  counter becomes `_total`, an up-down counter and an observable gauge become `gauge`, a unit adds
  no suffix).

### Listener

`PrometheusExporter` binds `localhost` unless told otherwise, which a scraper in another container
cannot reach. It is bound to `0.0.0.0`. Compose does not publish the port; a process started on a
host exposes it to the local network. The scrape holds counts and durations per route template and
fixed label values, no IDs and no personal data. A port that cannot be bound stops the process
(fail fast: metrics were asked for), so two processes on one host need different `METRICS_PORT`.

### Registration and shutdown

`startMetrics` builds the `MeterProvider` (resource `service.name`, the view, one reader) and
registers it globally; the reader is the Prometheus exporter unless a test passes its own. Shutdown
releases the instrumentation, shuts the provider down (which closes the listener) and disables the
global provider. Both preloads start metrics after tracing and shut it down on `SIGTERM`.

### Rejected

- **`prom-client` and a `/metrics` Nest route:** the worker has no HTTP server, so it needs its own
  listener anyway, and the request histogram would duplicate what the HTTP instrumentation already
  records with the route template.
- **`NodeSDK`:** same reason as in ADR 0007: it reads `OTEL_*` and starts exporters nobody
  configured.

### Consequences

- Good: one code path for API and worker; the app port carries no `/metrics`; off means no socket.
- Good: the label set of the request histogram is closed (three keys, a template or one of two
  fixed values for the route).
- Bad: the unmatched-route label depends on a view that must be kept in step with the
  instrumentation's attribute names.
- Bad: `0.0.0.0` makes the port reachable by anything on the network of the process.
- Bad: ESM hook registration stays a precondition; without the preload the route label is missing
  and every request reads `UNMATCHED`.

## Pros and cons of the options

### Option 1: SDK parts plus the Prometheus exporter

- Good: reuses the HTTP instrumentation; one listener per process; no `OTEL_*`.
- Bad: names and labels follow OpenTelemetry semantic conventions, not the Prometheus habit
  (`http_route`, no `_seconds`).

### Option 2: `prom-client`

- Good: familiar names; no OpenTelemetry metrics SDK.
- Bad: a second route-labelling mechanism and a listener in the worker anyway.

### Option 3: `NodeSDK`

- Good: one object.
- Bad: reads `OTEL_*`; starts exporters by default.
