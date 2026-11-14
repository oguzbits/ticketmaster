# 0007: Tracing with OpenTelemetry on postgres.js and node-redis

- Status: accepted
- Date: 2026-11-14

## Context and problem statement

A booking crosses the API, PostgreSQL, Redis, the outbox row, the queue and the worker's handlers.
One request should be one trace across all of them, and every log line written inside it should
carry the trace ID. The API and the worker are native ESM NestJS applications on Node 26, the
database driver is postgres.js, the Redis client is node-redis, and the queue is SQS through the AWS
SDK v3. Which pieces produce the spans, how are they registered under ESM, and how does the trace
cross the asynchronous gap?

## Decision drivers

- A mechanism that is proven on this stack (Node 26.12, Express 5 under NestJS, postgres.js 4.1.1,
  `@redis/client` 6.3.1, `@aws-sdk/client-sqs` 3.1168), not assumed.
- Tracing off (the default and every test project) is inert: no exporter, no hook, no subscription,
  no network call.
- Invariant 5: no `OTEL_*` variable is read; options come from the validated config.
- Invariant 6 and the span rules: no personal data in spans (no SQL parameters, no Redis keys, no
  error messages, no IP address).
- Few dependencies, and every version satisfies the peer ranges of the others and the repository's
  `minimumReleaseAge` and `trustPolicy`.

## Considered options

1. Official instrumentations for HTTP, Express and the AWS SDK, plus a small adapter that turns the
   `diagnostics_channel` events of postgres.js and node-redis into spans; the SDK is assembled from
   its parts. ESM hooks are registered synchronously with `import-in-the-middle`.
2. `@opentelemetry/sdk-node` (`NodeSDK`) with the same instrumentations.
3. `@opentelemetry/auto-instrumentations-node`.
4. A Drizzle logger hook for database spans, `instrumentation-pino` for log correlation, an
   OpenTelemetry collector in front of Tempo.

## Decision outcome

Chosen: option 1. Every statement below was run against the built `dist` of the API (and the
worker where noted) on Node v26.12.0 with the Compose services of `pnpm db:up`.

### Pinned versions

All of them install together with `pnpm add` under the repository's `minimumReleaseAge: 1440`,
`minimumReleaseAgeStrict` and `trustPolicy: no-downgrade`, with no peer warning and no install
script (`allowBuilds` needs no entry). The set is 25 packages, about 22 MB.

| Package                                    | Version | Used for                                                             |
| ------------------------------------------ | ------- | -------------------------------------------------------------------- |
| `@opentelemetry/api`                       | 1.10.0  | tracer, context, propagation API                                     |
| `@opentelemetry/sdk-trace`                 | 3.1.1   | `TracerProvider`, span processors, samplers, `InMemorySpanExporter`  |
| `@opentelemetry/context-async-hooks`       | 3.1.1   | `AsyncLocalStorageContextManager`                                    |
| `@opentelemetry/core`                      | 3.1.1   | `W3CTraceContextPropagator`, `CompositePropagator`                   |
| `@opentelemetry/resources`                 | 3.1.1   | `resourceFromAttributes` (`service.name`)                            |
| `@opentelemetry/instrumentation`           | 0.301.2 | `registerInstrumentations`                                           |
| `@opentelemetry/exporter-trace-otlp-http`  | 0.301.2 | OTLP over HTTP (JSON body, `application/json`)                       |
| `@opentelemetry/instrumentation-http`      | 0.301.2 | server span per request, client spans                                |
| `@opentelemetry/instrumentation-express`   | 0.73.0  | route template (`express` `>=4 <6`, so Express 5)                    |
| `@opentelemetry/instrumentation-aws-sdk`   | 0.80.0  | SQS spans and `traceparent` message attribute                        |
| `import-in-the-middle` (direct dependency) | 3.6.0   | synchronous ESM hook; it is also the dependency of `instrumentation` |

Dead ends found while reading the registry: `@opentelemetry/sdk-trace-base` (latest 2.12.0) has the
peer range `api >=1.3.0 <1.10.0` and cannot be used with `api` 1.10.0; its replacement is
`@opentelemetry/sdk-trace` 3.x. In 3.x the span processors take an options object
(`new SimpleSpanProcessor({ exporter })`); passing the exporter itself fails without an error and
drops every span.

### (a) ESM registration

`--import ./preload.js` is the only flag the app needs. The preload registers the hooks
synchronously, then builds the SDK:

```js
import { register } from 'import-in-the-middle/register-hooks.mjs';
register(); // module.registerHooks() under the hood; supportsSyncHooks() is true on Node >= 26.0.0
await import('./tracing.js'); // provider, context manager, propagator, registerInstrumentations
```

| Variant                                                           | Result on Node 26.12.0                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `import-in-the-middle/register-hooks.mjs` in the preload          | works; no warning. Chosen.                                                                         |
| `module.register('@opentelemetry/instrumentation/hook.mjs', ...)` | works, but prints `[DEP0205] module.register() is deprecated` on every start.                      |
| `--experimental-loader=.../hook.mjs`                              | works, prints `ExperimentalWarning: --experimental-loader may be removed in the future`.           |
| no hook                                                           | HTTP server spans exist but are named `GET` and have no `http.route`: Express is not instrumented. |

The hook must run before the application imports Express; the preload is loaded by `--import`
before `dist/main.js`, and with the module imported dynamically after `register()`. With tracing
off the preload returns before it registers or imports anything.

**Docker `CMD` for Task 7** (API and worker, working directory `/app`, preload path decided in
Task 2):

```text
CMD ["node", "--import", "./dist/infrastructure/tracing/preload.js", "dist/main.js"]
```

No `--experimental-loader`, no `NODE_OPTIONS`.

### (b) Server span with the route template

With `HttpInstrumentation` and `ExpressInstrumentation` the server span is named from the method and
the Express route template and carries `http.route`:

| Request                      | Span name             | `http.route`      |
| ---------------------------- | --------------------- | ----------------- |
| `GET /api/events/<uuid>`     | `GET /api/events/:id` | `/api/events/:id` |
| `GET /api/events/not-a-uuid` | `GET /api/events/:id` | `/api/events/:id` |
| `GET /health/ready`          | `GET /health/ready`   | `/health/ready`   |
| `GET /api/bookings` (401)    | `GET /api/bookings`   | `/api/bookings`   |
| `GET /api/nope/12345` (404)  | `GET /api*path`       | `/api*path`       |

The URL is never a span name; an unmatched path collapses into the catch-all route, so the label
set is bounded. No interceptor fallback is needed. `ExpressInstrumentation` is created with
`ignoreLayersType: ['middleware', 'router', 'request_handler']`: without it every request carries
seven internal layer spans (four middleware, three handler layers); with it the trace is the server span and its database, Redis and
queue children, and the name and `http.route` stay.

### (c) Database and Redis spans

postgres.js 4.1.1 and `@redis/client` 6.3.1 publish Node tracing channels. Nothing is published
while nobody subscribes. A subscription needs no `bindStore`: the `start` event runs in the async
context of the caller (also inside `sql.begin` transactions and `Promise.all`), so
`tracer.startSpan(name, options, context.active())` in `start` and `span.end()` in `asyncEnd` gives
a child of the active span. `bindStore` would need the context manager's `AsyncLocalStorage`, which
is private (`_asyncLocalStorage`); it is not used because nothing runs inside these spans.

Observed: every request produced `pg.query` and `redis` client spans with the request's trace ID and
the server span as parent, including `begin`, the statements and `commit` of a transaction, and
parallel statements.

**Event order** of one failing postgres.js query: `start`, `end`, `error`, `asyncStart`,
`asyncEnd` (node-redis uses `tracePromise` of the same `TracingChannel` class). End the span in `asyncEnd`; set the error status in `error`.

**postgres.js**, channel `tracing:postgres:query:*`, one context object per query (the same object
in all events, filled in as the query goes along):

| Field                                     | At `start`                                                        | At `asyncEnd`                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `query`                                   | string, `$1`, `$2` placeholders only (`select $1::text as b`)     | same                                                                                                |
| `parameters`                              | `undefined`; the values only with the client option `debug: true` | same                                                                                                |
| `database`, `user`                        | strings                                                           | same                                                                                                |
| `host`, `port`, `connection`, `statement` | `null`                                                            | `host` string, `port` number, `connection` number, `statement` string (`''` unnamed)                |
| `command`, `count`                        | `null`                                                            | `command` (`SELECT`), `count` (rows)                                                                |
| `queued`, `sent`, `firstByte`, `complete` | `queued` number, others `null`                                    | numbers (`performance.now()`)                                                                       |
| `error`                                   | absent                                                            | present on failure: a `PostgresError` with `name` `PostgresError` and `code` the SQLSTATE (`42P01`) |

`begin` and `commit` of `sql.begin` are queries as well (`query` is `begin ` and `commit`). The
parameters must never be read; the adapter never sets `debug`.

**node-redis**, channel `tracing:node-redis:command:*`:

| Field                       | Value                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `command`                   | string, the command name only (`EVAL`, `PING`, `ZRANGE`)                                                           |
| `args`                      | sanitised array that still contains keys for many commands: never read                                             |
| `database`                  | number                                                                                                             |
| `clientId`, `serverAddress` | strings                                                                                                            |
| `serverPort`                | number or `undefined`                                                                                              |
| `error`                     | on failure; its class is `SimpleError` and its `name` is `Error`, so use `error.constructor.name` for `error.type` |

Pipelines add `batchMode` and `batchSize` and publish `tracing:node-redis:batch:*` besides.

**Rules for the adapter (Task 3):**

- Parse each payload with a Zod schema at the boundary; read only `query`, `database`, `command`,
  `count` (postgres.js) and `command` (node-redis). The error status carries the error name only.
- Create a span only when there is an active span. Without that rule an idle worker produced 68
  one-span traces in nine seconds (51 `pg.query`, 16 Redis, 1 SQS, all from background loops); the API
  at start produced one (`SQS.GetQueueUrl`).
- `tracing:postgres:connect`, `postgres:transaction`, `postgres:pool` and `node-redis:connect` are
  not subscribed.

### (d) SQS: `traceparent` through the message attributes

`AwsInstrumentation` on a `SendMessage` inside an active span:

- creates a PRODUCER span `<queue> send` as a child of the active span and **writes the
  `traceparent` attribute (String) of that span** into `MessageAttributes`;
- **overwrites an attribute set explicitly.** An explicit `traceparent` of
  `00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01` was replaced by the trace and span ID of
  the send span (the input object is mutated in place). A message with only `messageId` came back
  with `messageId` and `traceparent`;
- on `ReceiveMessage` appends `traceparent` and `tracestate` to `MessageAttributeNames`, so the
  attribute comes back even when the code asks for `messageId` only. The emulator returned it.
  With tracing off nothing appends it: the adapter must list `traceparent` itself.

So the chain is: the relay continues the outbox row's `traceparent` (`outbox.send`), the SQS send
span is its child, the consumer extracts the attribute and its `queue.process` span is a child of
the send span, all in the request's trace ID. The explicit attribute written by the adapter matters
only with tracing off or with a fake queue in tests (it is overwritten, with the same trace ID,
when the instrumentation runs). A message sent with no active span still gets a `traceparent`,
that of its own root send span.

`ReceiveMessage` creates a CONSUMER span `<queue> receive` that is the root of its own trace (it
only links to the producers) for every long poll, empty ones included. The sampler drops it:
`shouldSample` answers `NOT_RECORD` for a span of kind CONSUMER with `messaging.operation.type`
`receive` and no parent, and defers to `ParentBasedSampler(AlwaysOn)` otherwise. The `receive` span
and its HTTP child disappear; the send spans, the database spans and the root remain.

### Registration and shutdown

- Providers are registered by hand: `trace.setGlobalTracerProvider(new TracerProvider({ resource,
sampler, spanProcessors }))`, `context.setGlobalContextManager(new
AsyncLocalStorageContextManager().enable())`, `propagation.setGlobalPropagator(new
CompositePropagator({ propagators: [new W3CTraceContextPropagator()] }))`, then
  `registerInstrumentations({ instrumentations })`.
- Export: `new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url }) })`. `url` is used as
  given, so the config's base URL gets `/v1/traces` appended. A local HTTP sink received
  `POST /v1/traces` with `application/json` after the shutdown flush. With an unreachable endpoint
  (`http://localhost:1`) the API started, answered and stopped without an error in its log.
  Spans are flushed only if `provider.shutdown()` runs: call it from the Nest shutdown hook.
- Span processors run in the order given. A processor placed before the exporter's and deleting
  keys from `span.attributes` in `onEnd` removes them from the exported span (verified with the
  in-memory exporter).

### `OTEL_*` decision

No `OTEL_*` variable is set anywhere in the repository and the code passes explicit options.
`NodeSDK` is rejected for this reason: in 0.301.2 its constructor and `start()` read
`OTEL_SDK_DISABLED`, `OTEL_LOG_LEVEL`, `OTEL_NODE_RESOURCE_DETECTORS`, the sampler and exporter
variables, and with none set it **creates an OTLP metrics reader and an OTLP logs exporter** (read
in `sdk.mjs` and `utils.mjs` of the package). That sends data nobody configured and reads the
environment outside the config module. The assembled SDK reads none of these; the only fallback
left is in the OTLP exporter (`OTEL_EXPORTER_OTLP_TIMEOUT`, `_COMPRESSION`, headers), which Task 2
closes by passing `url`, `timeoutMillis`, `compression` and `headers` explicitly.

### Personal data in the default attributes

The HTTP server span carries `client.address`, `network.peer.address`, `network.peer.port`,
`user_agent.original` and, when a query string is present, `url.query` (only credential-like
parameters are redacted). These are personal data under invariant 6. Task 2 adds a span processor
that deletes those keys in `onEnd` (see above); `url.path` stays (it holds IDs, no names).
`recordException` stays off everywhere.

### Rejected

- **`auto-instrumentations-node`:** loads dozens of instrumentations (including `pg` and `ioredis`,
  which do not match these drivers) and wraps `NodeSDK`; bigger and reads `OTEL_*`.
- **`instrumentation-pino`:** nestjs-pino under ESM is not proven to be patched; a pino `mixin`
  that reads the active span is shorter and testable.
- **A Drizzle logger hook:** it sees the statement before it runs, not its duration, error or
  parent, and misses statements that bypass Drizzle. The driver channel sees every query.
- **An OpenTelemetry collector:** one more container for no pipeline step. Tempo takes OTLP over
  HTTP directly.
- **`module.register()` and `--experimental-loader`:** deprecated or experimental, see (a).

### Logs and the observability profile

Tempo, Loki, Alloy and Grafana run in the Compose profile `observability`; the default stack and
`pnpm e2e` do not start it. pino keeps writing JSON lines to stdout. Alloy reads the Docker socket
mounted read-only and ships the container logs to Loki, because Promtail is end of life (a statement of the phase plan, checked again in Task 7). The socket
gives read access to every container's metadata and logs, so the profile is for local use only and
is not part of any deployment. Image tags and the Alloy configuration are verified against the
registries and docs in Task 7.

### Consequences

- Good: one trace from the request through PostgreSQL, Redis, the outbox row, the queue and the
  worker; the route template is the span name; nothing is exported or hooked with tracing off.
- Good: 25 packages and about 22 MB, against about 41 MB with `NodeSDK`; the environment is read in
  one place.
- Bad: the adapter for postgres.js and node-redis is ours (about a page), and it depends on the
  channel payloads documented above; the version pins protect it, and its tests feed the same
  shapes.
- Bad: a sampler rule and a span processor of our own (dropping `receive` roots, deleting personal
  attributes) must be kept in step with the instrumentations' attribute names.
- Bad: the assembled SDK has no meter provider; slice B decides how the HTTP metrics are exposed.
- Bad: PgBouncer sits between the processes and PostgreSQL, so `server.address` names the pooler,
  not the database server. Accepted.
- Not checked here: the long-lived seat stream (`/api/events/:id/seats/stream`) keeps its server
  span open for the whole stream; Task 2 decides whether to ignore that route.
- Cost: four more containers in the profile (Tempo, Loki, Alloy, Grafana; the memory budget goes
  into the phase 5 ADR); the added work per request is not measured.

## Pros and cons of the options

### Option 1: official instrumentations plus a channel adapter, SDK assembled by hand

- Good: every piece was proven on this stack; no hidden exporters; small.
- Bad: more wiring code than `NodeSDK`; the adapter is ours.

### Option 2: `NodeSDK`

- Good: one object, the documented path.
- Bad: reads `OTEL_*` and starts metrics and logs exporters by default; 41 MB with its transitive
  exporters.

### Option 3: `auto-instrumentations-node`

- Good: no list of instrumentations to keep.
- Bad: wrong drivers (`pg`, `ioredis`), large, reads `OTEL_*`.

### Option 4: Drizzle hook, `instrumentation-pino`, collector

- Good: no new code in the instrumentation set.
- Bad: each is either blind to part of the traffic, unproven under ESM, or one more moving part.
