# Phase 3, slice A: tracing and correlated logs, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One booking is a single trace from the HTTP request through PostgreSQL, Redis, the outbox row, the queue and the worker's handlers, and every log line written inside that trace carries its `trace_id`.

**Architecture:** A preload module (`node --import`) starts the OpenTelemetry SDK from the validated config before the app imports anything. HTTP and AWS SDK use the official instrumentations; postgres.js and node-redis publish `diagnostics_channel` events that a small adapter turns into spans (no official instrumentation fits these drivers). The trace context crosses the asynchronous gap through a nullable `traceparent` column on the outbox row, which the relay puts into the SQS message attributes and the consumer continues. pino adds `trace_id` and `span_id` from the active span. Tempo, Loki, Alloy and Grafana run in the Compose profile `observability`.

**Tech Stack:** `@opentelemetry/*` (versions read from the registry in Task 1), NestJS 12 ESM, postgres.js 4, node-redis 6, nestjs-pino, Drizzle, Grafana Tempo/Loki/Alloy/Grafana, Vitest.

**Spec:** [Phase 3 design, slice A](../specs/2026-11-14-phase-3-observability-and-measuring-design.md#slice-a-tracing-and-correlated-logs)

## Global Constraints

- AGENTS.md applies: no `vi.mock`, no `any`, no `as unknown as`, no `export *`, no `unknown` as a parameter or return type (the payloads of a diagnostics channel are parsed with Zod at the boundary), relative imports end in `.js`, modules import each other through `index.ts`, `// SAFETY:` on every assertion except `as const`, English docs, Conventional Commits straight on `main`, hooks never skipped, `pnpm check` green before every commit.
- Env only through the config module. The SDK is built with explicit options from `Env`; no `OTEL_*` variable is set anywhere in the repo (the SDK would read them from `process.env` itself, which is a hole in invariant 5).
- Span names and attribute keys are `as const` dictionaries (`SPAN_NAME`, `SPAN_ATTR`) imported by code and tests (`pnpm audit:magic`).
- No personal data in spans or logs: SQL spans carry the statement text with placeholders and never the parameters; Redis spans carry the command name only, never keys or arguments; a failed span records the error name only, never `recordException` (the message may hold data); no user, e-mail or booking payload attribute. IDs only.
- With `TRACING_ENABLED=false` (the default, and in every test project) no exporter, no hook and no channel subscription exists; an unmocked network call in a unit test still fails the test. Tests use `InMemorySpanExporter`.
- Time only from `Clock`; the tracing code reads no clock of its own except what the SDK does.
- Migrations: drizzle-kit generates them (`pnpm db:generate`), never edited by hand, expand step only (nullable column), commit subject ends with `[braucht Live-Migration]`; `docs/data-model.md` changes in the same commit.
- Run `df -h` before the first image pull (Task 7); about 20 GiB were free at the start of the phase.

## Deviations from the spec (decided here)

- **postgres.js and node-redis, not `pg` and ioredis.** The spec named the wrong drivers. There is no official instrumentation for postgres.js, and the one for node-redis targets the callback API. Both drivers publish tracing channels; Task 1 verifies them and records the result in ADR 0007 (`docs/adr/0007-tracing-with-opentelemetry.md`, written in Task 1).
- **The outbox row stores the trace context.** The relay runs seconds after the request, in another process, so it cannot know the request's trace. `outbox_messages.traceparent` (nullable text) is written by `OutboxService.enqueue` from the active span. The queue message body and `QueueMessageSchema` do not change.
- **The consumer span is a child of the relay's send span, not only a link,** so a booking is one trace ID end to end (the spec's test asks for the same trace ID).
- **No `instrumentation-pino`.** nestjs-pino under ESM is not proven to be patched; a pino `mixin` reading `trace.getActiveSpan()` is shorter and testable.
- **Alloy ships the logs to Loki** (Promtail is end of life); it reads the Docker socket read-only. Local profile only, recorded in the ADR.
- **The browser sends no `traceparent`;** the API's HTTP server span is the root of the trace (an incoming header is still honored by the instrumentation). No web code changes.
- **A run's trace link needs the trace stored** (`simulation_runs.traceparent`, Task 8), so the worker continues the trace that started the run.

## Interfaces (exact signatures)

```ts
// apps/api/src/config/env.ts (EnvSchema gains)
TRACING_ENABLED: z.stringbool().default(false),
TRACING_OTLP_ENDPOINT: z.url().default('http://localhost:4318'), // base URL; '/v1/traces' is appended
GRAFANA_URL: z.url().optional(), // Task 8 only; unset hides the trace link

// apps/api/src/infrastructure/tracing/tracing.ts
export const SERVICE_NAME = { API: 'ticketmaster-api', WORKER: 'ticketmaster-worker' } as const;
export type ServiceName = (typeof SERVICE_NAME)[keyof typeof SERVICE_NAME];
export interface TracingHandle { shutdown(): Promise<void> }
/** null (and nothing registered) when TRACING_ENABLED is false. `spanProcessor` replaces the OTLP exporter (tests). */
export function startTracing(
  env: Pick<Env, 'TRACING_ENABLED' | 'TRACING_OTLP_ENDPOINT'>,
  options: { serviceName: ServiceName; spanProcessor?: SpanProcessor }
): TracingHandle | null;

// apps/api/src/infrastructure/tracing/span.ts
export const SPAN_NAME = {
  OUTBOX_SEND: 'outbox.send',
  QUEUE_PROCESS: 'queue.process',
  QUEUE_EFFECT: 'queue.effect',
  HOLD_STRATEGY: 'booking.hold.strategy',
  // plus the names the channel adapters use (Task 3)
} as const;
export const SPAN_ATTR = { STRATEGY: 'booking.strategy', EFFECT: 'queue.effect', MESSAGE_ID: 'queue.message_id' } as const;
/** Runs `fn` in a new active span; on a throw sets status ERROR with the error name only, ends the span, rethrows. */
export function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  options?: { kind?: SpanKind; attributes?: Record<string, string | number | boolean> }
): Promise<T>;

// apps/api/src/infrastructure/tracing/trace-context.ts
/** W3C `traceparent` of the active span, or null without a valid active span. */
export function currentTraceparent(): string | null;
/** Runs `fn` with the remote context of `traceparent`; null or a malformed value runs `fn` in a fresh root context (never throws). */
export function withExtractedContext<T>(traceparent: string | null, fn: () => Promise<T>): Promise<T>;

// apps/api/src/infrastructure/logging/trace-mixin.ts
export function traceMixin(): { trace_id?: string; span_id?: string }; // empty object without an active span

// apps/api/src/modules/outbox/domain/message-queue.ts
send(input: { body: string; messageId: string; traceparent: string | null }): Promise<void>;
// ReceivedMessage gains: traceparent: string | null  (null: the message had no valid attribute)
// SQS message attribute name: 'traceparent' (String)

// apps/api/src/infrastructure/database/schema.ts
// outbox_messages.traceparent text null;  simulation_runs.traceparent text null (Task 8)
```

## Review Focus

Failure modes the spec implies but no task would exercise by itself. Each has a test in the task named in brackets.

1. **Tracing off must be inert** (the default, all test projects): no exporter, no channel subscription, no network call. [Task 2]
2. **Tempo unreachable:** a rejecting export must not fail a request or crash the process; the booking still succeeds. [Task 2]
3. **A queue message with no or a garbage `traceparent`** (an old message, a hand-sent one) is handled and starts a new trace. [Task 5]
4. **Outbox rows written before the migration** have `traceparent` null; the relay sends them with no attribute. [Task 5]
5. **No personal data in spans:** SQL parameters, Redis keys and arguments, and error messages never appear in any attribute. [Tasks 3, 5]

### Task 1: Spike, then ADR 0007

**Files:** Create `docs/adr/0007-tracing-with-opentelemetry.md` (MADR like the others). Scratch code goes in the scratchpad directory, not into the repo.

**Produces:** the decisions every later task relies on, written down with the evidence.

- [ ] **Step 1: Read the sources, not memory.** For each of `@opentelemetry/api`, `sdk-node`, `exporter-trace-otlp-http`, `instrumentation-http`, `instrumentation-express`, `instrumentation-aws-sdk` and the in-memory exporter: `npm view <pkg> version peerDependencies` and the README of the version to install. Pin versions that satisfy each other's peer range (a first research found `api` 1.10.0 with `sdk-node` and `exporter` 0.301.2; confirm). Read the postgres.js and `@redis/client` docs for their tracing channels (`postgres:query`; `tracing:node-redis:command`) and the payload shapes.
- [ ] **Step 2: Prove four things with a throwaway script against the built `dist` on Node 26** (`pnpm db:up` first): (a) ESM registration: which of `--import` plus `--experimental-loader=@opentelemetry/instrumentation/hook.mjs`, or `module.register(...)` inside the preload works on this Node, with the app started as `node dist/main.js`; (b) a server span from `instrumentation-http` that gets its route template as the name or an `http.route` attribute under Express 5 (if `instrumentation-express` does not support Express 5, decide the fallback: a global interceptor that sets the span name from the matched route template; the URL is never a span name); (c) a child span per postgres.js statement and per node-redis command, in the same trace as the request, via the tracing channels (needs `bindStore` on the channel with the OTel context manager's `AsyncLocalStorage`, or an equivalent); (d) an outgoing SQS `SendMessage` carries a `traceparent` attribute from `instrumentation-aws-sdk` and whether it overwrites an attribute set explicitly.
- [ ] **Step 3: Write the ADR** with: the chosen mechanism per piece and the rejected ones (`auto-instrumentations-node`, `instrumentation-pino`, a Drizzle logger hook, a collector), the pinned versions, the `OTEL_*` decision, the Alloy and Docker-socket decision, and the cost. If (a), (b) or (c) cannot work, stop and report; do not widen scope.
- [ ] **Step 4: Commit** `docs(adr): tracing with OpenTelemetry on postgres.js and node-redis`.

### Task 2: Tracing bootstrap and the switch

**Files:** Create `apps/api/src/infrastructure/tracing/{tracing.ts,span.ts,trace-context.ts,index.ts}`, `apps/api/src/tracing.preload.ts`, `apps/worker/src/tracing.preload.ts`; modify `apps/api/src/config/env.ts`, `.env.example`, `CONTRIBUTING.md`, `apps/api/package.json` (dependencies, `./tracing` export), `apps/worker/package.json`. Tests: `tracing.spec.ts`, `span.spec.ts`, `trace-context.spec.ts` next to the code, `env.spec.ts`.

**Consumes:** the ADR's registration mechanism. **Produces:** `startTracing`, `withSpan`, `currentTraceparent`, `withExtractedContext`, `SPAN_NAME`, `SPAN_ATTR`, `SERVICE_NAME` (signatures above), exported through the `./tracing` entry.

- [ ] **Step 1: Tests first.** `tracing.spec.ts`: `startTracing({ TRACING_ENABLED: false, ... }, ...)` returns null and creates no tracer provider (`trace.getTracerProvider()` is still the no-op one); with `true` and an `InMemorySpanExporter` span processor, a `withSpan` span is exported and `shutdown()` flushes it; with a processor whose export rejects, `withSpan` still resolves with the callback's value. `span.spec.ts`: a throwing callback rethrows, the span has status ERROR and the error _name_ as the description, no exception event with a message. `trace-context.spec.ts`: `currentTraceparent()` is null outside a span and matches `^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$` inside; `withExtractedContext('00-<trace>-<span>-01', ...)` runs `currentTraceparent()` with that trace ID once a span is started inside; `null`, `''` and `'garbage'` run the callback without throwing and start a different trace. `env.spec.ts`: `TRACING_ENABLED` defaults to false, `'true'` parses to true, a bad endpoint fails naming the variable.
- [ ] **Step 2: Run them, expect FAIL.** `pnpm vitest run --project api infrastructure/tracing config/env`.
- [ ] **Step 3: Implement** the three modules and the env entries. `startTracing` builds `NodeSDK` (or the SDK pieces the ADR chose) with explicit options: resource `service.name`, a batch span processor with the OTLP HTTP exporter at `${TRACING_OTLP_ENDPOINT}/v1/traces` and short export timeouts, HTTP and AWS SDK instrumentations only. Both preload files call `startTracing(loadEnv(), { serviceName })` and register `process.once('SIGTERM', ...)` to flush; the API one is the only place besides `loadEnv` that touches the environment. Update `.env.example` (every variable, `pnpm docs:generate` checks it) and the variable list in `CONTRIBUTING.md`.
- [ ] **Step 4: Run again, expect PASS;** then `pnpm build` and start `node --import ./dist/tracing.preload.js dist/main.js` by hand once with `TRACING_ENABLED=true` and no Tempo: `/health/live` answers 200 and the log shows no crash.
- [ ] **Step 5: Hand mutation** (AGENTS section 4): make `startTracing` ignore `TRACING_ENABLED`; the "returns null" test must go red. Revert.
- [ ] **Step 6: `pnpm check`, commit** `feat(tracing): start OpenTelemetry from the validated config`.

### Task 3: Database and Redis spans

**Files:** Create `apps/api/src/infrastructure/tracing/channel-spans.ts` (subscribes to the driver channels, called from `startTracing` only when enabled) and `channel-spans.spec.ts`; modify `tracing.ts` and `SPAN_NAME`.

**Produces:** `export function subscribeDriverSpans(): () => void` (returns the unsubscribe). Payloads are parsed with Zod schemas of the fields used; an unparsable payload is ignored without a span and without a throw.

- [ ] **Step 1: Tests first** (offline, publishing on the real channels with a fake payload is allowed; they are the driver's contract): a published `postgres:query` event inside a `withSpan` produces a client span, child of the active span, named `db.query` with `db.system=postgresql` and `db.statement` equal to the text with `$1` placeholders; the span never contains the parameter values passed in the event. A node-redis command event produces a span `redis.command` with `db.system=redis` and `db.operation` the command name; keys and arguments appear nowhere in the attributes. After `unsubscribe()` nothing is recorded. A garbage payload produces no span. A db spec (`pnpm test:db`) runs one real Drizzle query and one real Redis command inside a span and finds both child spans (the proof that the channels carry what the adapter expects).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with the mechanism the ADR chose (tracing channel start/end/error handlers; the span ends on `asyncEnd`/`error`; the error name only).
- [ ] **Step 4: Run, expect PASS.** `pnpm test`, `pnpm test:db`, `pnpm test:db:pooled` (the pooler must not change the result).
- [ ] **Step 5: Hand mutation:** put the parameters into `db.statement`; the parameter test must go red. Revert.
- [ ] **Step 6: `pnpm check`, commit** `feat(tracing): spans for postgres.js and node-redis`.

### Task 4: Log correlation

**Files:** Create `apps/api/src/infrastructure/logging/trace-mixin.ts` and `.spec.ts`; modify `http-log.ts` (add `mixin: traceMixin`), `apps/worker/src/worker.module.ts` (`LoggerModule.forRoot({ pinoHttp: { mixin: traceMixin } })`), `http-log.spec.ts`.

**Consumes:** the Task 2 tracing exports (a `withSpan` span is the active span in the tests).

- [ ] **Step 1: Tests first.** `traceMixin()` returns `{}` outside a span and `{ trace_id, span_id }` (32 and 16 hex characters, equal to the active span's) inside. A pino instance built from `httpLogOptions` (destination: an in-memory stream) writes a line with the active trace ID when logged inside a span, and a line without the keys otherwise. A worker spec: a `Logger` call inside `withSpan` in the worker's module config writes the trace ID (use the same in-memory destination).
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Hand mutation:** return `{}` always; both tests go red. Revert.
- [ ] **Step 4: `pnpm check`, commit** `feat(logging): trace_id and span_id on every log line in a trace`.

### Task 5: Trace context through the outbox and the queue (review task)

**Files:** Modify `schema.ts` (+ generated migration), `docs/data-model.md`, `outbox.service.ts`, `domain/message-queue.ts`, `adapters/sqs-message-queue.ts`, `testing/fake-message-queue.ts` (records `traceparent`), `apps/worker/src/queue-consumer.ts`. Tests: `outbox.service.db.spec.ts`, `sqs-message-queue.db.spec.ts`, `outbox-relay`/`queue-consumer.db.spec.ts`, new `apps/worker/src/booking-trace.db.spec.ts`.

**Consumes:** `currentTraceparent`, `withExtractedContext`, `withSpan`, `SPAN_NAME.OUTBOX_SEND`, `QUEUE_PROCESS`, `QUEUE_EFFECT`.

- [ ] **Step 1: Tests first.**
  - `outbox.service.db.spec.ts`: `enqueue` inside a span stores that span's `traceparent`; outside a span it stores null. **Guard:** dropping the write turns the first red.
  - Relay (fake queue): the row's stored `traceparent` is active while sending, so `FakeMessageQueue.sent[0].traceparent` has the stored trace ID and a send span (`outbox.send`) exists in that trace; a row with null `traceparent` is sent with a `traceparent` of the new send span's trace (or null when tracing is off) and does not fail (Review Focus 4). **Guard:** not passing `traceparent` to `send` turns the first red.
  - `sqs-message-queue.db.spec.ts`: a send with `traceparent` arrives with a `traceparent` String attribute equal to it; `receive` returns it as `traceparent`; a message sent with no attribute and one with the attribute set to `'garbage'` both come back as `traceparent: null` (parse with a Zod regex; never throw).
  - `queue-consumer.db.spec.ts`: a message with a valid `traceparent` gets a `queue.process` span whose trace ID is the message's and one `queue.effect` span per effect (`SPAN_ATTR.EFFECT` = the effect's consumer name); a message without one is handled and starts a new trace (Review Focus 3); a failing effect ends its span with ERROR and the message stays in the queue as before. **Guard:** not extracting the context turns the same-trace test red.
  - `booking-trace.db.spec.ts` (the slice's proof): inside a root span run `BookingsService.pay` for a held seat, then one relay run against the scratch queue, then the consumer on that message with `InMemorySpanExporter` registered. Assert every exported span of the flow (HTTP excluded, there is no server) shares the root's trace ID, and that the set contains a `db.query`, an `outbox.send`, a `queue.process` and both `queue.effect` spans. Attributes of all spans contain neither the user ID nor an e-mail address (Review Focus 5).
- [ ] **Step 2: Run, expect FAIL** (`pnpm test:db`).
- [ ] **Step 3: Implement.** Add `traceparent: text('traceparent')` and run `pnpm db:generate` (do not hand-edit). `enqueue` writes `currentTraceparent()`. `OutboxService.relay` wraps each row's send in `withExtractedContext(row.traceparent, () => withSpan(SPAN_NAME.OUTBOX_SEND, ...))` and passes `currentTraceparent()` taken inside the span; the error name stays the failure value as today. `SqsMessageQueue.send` sets the `traceparent` attribute when the value is non-null; `receive` adds `traceparent` to `MessageAttributeNames` and parses it. The consumer wraps `dispatch` and each effect as described (`kind: SpanKind.CONSUMER` for the process span). The message ID is a span attribute; nothing from the body.
- [ ] **Step 4: Run, expect PASS:** `pnpm test`, `pnpm test:db`, `pnpm test:db:pooled`. Update the outbox and DB-schema paragraphs of `docs/data-model.md`.
- [ ] **Step 5: Hand mutations:** (a) not storing the column, (b) not extracting in the consumer, (c) not passing it in the relay: each must turn a named test red. Revert.
- [ ] **Step 6: `pnpm check`, commit** `feat(outbox): carry the trace context through the queue [braucht Live-Migration]`. Docs in the same commit.
- [ ] **Step 7: Own review** (this task touches context propagation): re-read the diff for a span that is never ended on the early-return paths of `next()` and for any attribute that could hold a body.

### Task 6: Hold strategy spans

**Files:** Modify `apps/api/src/modules/bookings/bookings.service.ts:84` (the one call `this.reservations.hold(event.strategy, input)`), its spec.

- [ ] **Step 1: Test first** (offline service spec with an in-memory exporter): a hold produces one `booking.hold.strategy` span with `booking.strategy` equal to the event's strategy and ends it when the hold is `CONFLICT`/taken (not an error) and when it throws (ERROR). **Guard:** removing the wrapper turns it red.
- [ ] **Step 2: Implement** the wrap with `withSpan(SPAN_NAME.HOLD_STRATEGY, ..., { attributes: { [SPAN_ATTR.STRATEGY]: event.strategy } })`. No seat or user ID attribute.
- [ ] **Step 3: `pnpm test`, `pnpm check`, commit** `feat(bookings): one span per hold strategy call`.

### Task 7: The `observability` profile

**Files:** Create `docker/observability/{tempo.yaml,loki.yaml,alloy.river,grafana/provisioning/datasources/datasources.yaml}`, `docs/observability.md`; modify `docker-compose.yml`, `Dockerfile` (api and worker `CMD ["node", "--import", "./dist/tracing.preload.js", ...]` plus whatever flag the ADR requires), `docs/docs-map.json` (`"docker/observability/": "docs/observability.md"`), `CONTRIBUTING.md`, `README.md`.

- [ ] **Step 1: `df -h`.** Read the current image tags and config reference for Tempo, Loki, Alloy and Grafana from their docs (a first check listed `grafana/tempo:3.1.1`, `grafana/loki:3.7.10`, `grafana/grafana:13.3.1`; verify, pick Alloy's). Pin by tag like the other images.
- [ ] **Step 2: Compose.** Services `tempo`, `loki`, `alloy`, `grafana` under `profiles: [observability]`, with health checks and persistent volumes; Grafana's anonymous access is off and its admin password comes from a Compose variable with a local default (like the other local credentials). `api` and `worker` get `TRACING_ENABLED: ${TRACING_ENABLED:-false}` and `TRACING_OTLP_ENDPOINT: http://tempo:4318`. `docker-compose.e2e.yml` and `pnpm e2e` stay without the profile and without tracing; the default `docker compose up` starts none of the four.
- [ ] **Step 3: Provisioning.** Data sources `tempo` (uid `tempo`, with "traces to logs" using the `trace_id` field) and `loki` (uid `loki`, derived field on `trace_id` linking to Tempo). Alloy discovers the Docker containers of the project, parses the JSON line and labels by service.
- [ ] **Step 4: Verify by hand with the stack:** `TRACING_ENABLED=true docker compose --profile observability up --build -d`, log in with the demo login, hold and pay a seat. Then query the Tempo API (`/api/search`, `/api/traces/<id>`) for the trace: it holds spans of `ticketmaster-api` (server, `db.query`, `redis.command`) and `ticketmaster-worker` (`outbox.send`, `queue.process`, both effects) with one trace ID. Query Loki for `{service="api"} | json | trace_id="<id>"` and for the worker; both return lines. Open Grafana in the browser (chrome-devtools MCP): Tempo trace view shows the waterfall; the log-to-trace link works. Record the steps and the two API queries in `docs/observability.md` (a repeatable check, not a CI job: it needs the profile).
- [ ] **Step 5: Without the profile** `docker compose up -d` and `pnpm e2e` behave as before (run `pnpm e2e` once).
- [ ] **Step 6: Docs and commit.** `docs/observability.md` (how to start, what a trace contains, what is not traced: the browser; PgBouncer shows as the database host), README/CONTRIBUTING lines, docs-map entry. Commit `feat(infra): observability profile with Tempo, Loki, Alloy and Grafana`.

### Task 8: Trace link on the simulator page

**Files:** schema + migration (`simulation_runs.traceparent`), `docs/data-model.md`, `packages/shared` (`SimulationRunSchema` gains `traceUrl: z.url().nullable()`), `simulations.service.ts` and its controller mapping, `apps/worker/src/simulation.consumer.ts`, `apps/api/src/config/env.ts` (`GRAFANA_URL`), `.env.example`, the simulator page and store in `apps/web/src/app` (find with `grep -ril simulation apps/web/src`), docs.

- [ ] **Step 1: Tests first.** Service: a run started inside a span stores its `traceparent`; the run response has `traceUrl` built from `GRAFANA_URL` and the trace ID when the variable is set and the run has a trace, and `null` otherwise (no variable, or no trace). Worker consumer: the run's spans are in the stored trace (`withExtractedContext(run.traceparent, ...)`). Web: the link renders for a finished run with a `traceUrl`, opens in a new tab with `rel="noopener noreferrer"`, and is absent when `traceUrl` is null; the existing four states stay untouched. **Guard:** building the URL from the wrong field turns the service test red.
- [ ] **Step 2: Implement.** The URL opens Grafana Explore on the `tempo` data source with the trace ID query; read the current Explore URL format from the Grafana docs and check the link in the browser (chrome-devtools MCP). The ID is a 32-hex trace ID: no personal data.
- [ ] **Step 3: Run** `pnpm test`, `pnpm test:db`, `pnpm test:db:pooled`, the web tests, `pnpm check`; inspect the page in the browser with and without `GRAFANA_URL`.
- [ ] **Step 4: Commit** `feat(simulations): link a run to its trace [braucht Live-Migration]`, docs in the same commit.

### Task 9: Final verification, docs, report

- [ ] **Step 1:** `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm test:db:pooled`, `df -h`, `pnpm e2e` (no profile) all green; push; `gh run list --branch main --limit 1` green.
- [ ] **Step 2: Whole-slice review** with the strongest model (one run): context propagation, span leaks, personal data in attributes, the Docker-socket mount, tracing-off inertness.
- [ ] **Step 3: BACKLOG.** Add the slice A state block and the deviations (drivers, stored trace context, child instead of link, Alloy, no browser spans), and the open points: traces of a retry or redelivery are children of the same send span (one trace, several consumer spans); sampling is "always on" (fine for the demo, revisit before the live demo); the Docker-socket mount of Alloy; no `traceparent` on rows older than the migration; the Grafana profile is not part of CI so the trace check in `docs/observability.md` is by hand; dev (`pnpm dev`) runs without tracing.
- [ ] **Step 4: Stop and report** (state, deviations, open points) per AGENTS.md; append the ledger below.

## Out of scope

Metrics, dashboards, alert rules (slice B), the audit log (C), k6 and the cache (D), browser spans, sampling and tail sampling, a collector, trace retention settings beyond Tempo's local defaults, alert delivery.

## Ledger

Subagent runs, one bundle per row (duration and subagent tokens from the Agent result):

| Bundle                                | Duration               | Subagent tokens |
| ------------------------------------- | ---------------------- | --------------- |
| Task 1 (spike, ADR)                   | 738 s                  | 180,903         |
| Tasks 2, 3 (bootstrap, channel spans) | 994 s                  | 156,814         |
| Tasks 4, 6 (log mixin, hold span)     | 259 s                  | 86,388          |
| Task 5 (queue context)                | 755 s                  | 142,762         |
| Task 5 review (pruefer)               | 62 s                   | 64,904          |
| Task 7 (observability profile)        | 1,312 s                | 184,826         |
| Task 8 (trace link)                   | 1,197 s                | 185,351         |
| Verification run                      | 344 s                  | 57,900          |
| Whole-slice review (strongest model)  | 288 s                  | 128,754         |
| Fix wave                              | not measured           | not measured    |
| **Total** (without the fix wave)      | 5,949 s (about 99 min) | 1,188,602       |

Task 5 was resumed once after a rate limit.
