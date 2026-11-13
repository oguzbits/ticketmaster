# Phase 1, slice D: rush simulator. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin starts a rush (default 500 virtual buyers against 100 seats) under one booking
strategy and watches bookings, conflicts, retries, double bookings and p50/p95 latency live. Finished
runs are compared per strategy. `naive` shows double bookings above zero, every other strategy zero.

**Architecture:** The API validates the request, creates a fresh sandbox event with M seats and a
`simulation_runs` row, and appends `{ runId }` to the Redis stream `simulations`. A worker consumer
(consumer group) reads it, runs the buyers against `BookingsService.hold` with bounded concurrency
(no HTTP, synthetic user IDs), writes progress to a Redis key every 250 ms, counts double bookings in
SQL at the end and stores the final metrics. The API serves the run and an SSE stream that reads the
progress key.

**Spec:** [phase 1 design](../specs/2026-11-13-phase-1-core-design.md), section "Slice D". Rules:
[AGENTS.md](../../../AGENTS.md). UI: [PRODUCT.md](../../../PRODUCT.md), [DESIGN.md](../../../DESIGN.md).

## Global Constraints

- Every rule of AGENTS.md applies (`.js` suffixes, no `any`/`unknown` parameters, `// SAFETY:` on
  assertions, dictionaries for steering values, no `vi.mock`, no `console`, `process.env` only in
  `src/config`, UI states empty/loading/error+retry/pending).
- Domain code stays pure: no clock, no random, no Redis. Time and randomness are injected.
- A change in `packages/shared/src/` needs a change under `docs/api/` in the same commit; a schema
  change needs `docs/data-model.md`. The migration comes from `pnpm db:generate` and is tagged
  `[braucht Live-Migration]` in the commit subject (new table, expand step).
- Tests: `*.spec.ts` offline, `*.db.spec.ts` with Postgres and Redis (`pnpm db:up`,
  `pnpm db:migrate`, `pnpm test:db`). Every guard has a test that turns red when the guard is
  removed; try the mutation by hand and write it in the commit body.
- One topic per commit, Conventional Commits, `pnpm check` green, hooks never skipped, push to
  `main`, then `gh run list --branch main --limit 1`. `df -h` before the Compose runs.

## Decisions taken in this plan

- **Always a fresh sandbox event.** The spec's optional `eventId` is dropped: a run on a public
  event would fill it with synthetic bookings. The event copies nothing from a venue's seats; it
  gets M generated seats (`generate_series` in one SQL statement) at the first venue by name, owner
  and `sandbox_user_id` = the admin, so it never shows in the public list.
- **Concurrency cap counts rows, not a Redis counter.** At most 2 runs with status QUEUED or RUNNING
  and `started_at` within the last 10 minutes (`SIMULATION_RUN_TIMEOUT_MS`), checked inside the
  creating transaction under an advisory lock (same pattern as `MAX_EVENTS_PER_OWNER`). A counter
  would stay stuck when the worker dies; the time window heals itself. The 11th minute frees the slot
  of a dead run.
- **Progress through a Redis key, not pub/sub.** The worker `SET`s `simulation:<id>:progress` (TTL
  1 h) every 250 ms; the SSE route polls it every 250 ms. No subscriber connection, no
  snapshot-versus-subscribe race, works across API instances. Final state is in the database.
- **Retry means another seat.** A conflict on a seat is final (the seat is taken), so a buyer retries
  by picking another random seat, at most `MAX_ATTEMPTS_PER_BUYER` (3) attempts. `retries` counts
  attempts beyond a buyer's first.
- **Command carries only the run ID**; the worker reads the parameters from the row (one source of
  truth). A malformed message or an unknown run is logged and acknowledged (no poison loop). A
  failing run is stored as FAILED and acknowledged. A message of a crashed worker stays pending and
  is not re-claimed (backlog).
- **Public by run ID:** `GET /api/simulations/:id` and its stream need no token; the run ID is a
  random UUID and the payload is aggregate numbers only. Start and list are admin-only.
- **Out of scope:** simulator queue with visible position and global caps (phase 5), Grafana trace
  link (phase 3), paying in the simulation, cleanup of old simulation events (backlog).

## Review Focus

1. Admin-only start and list: customer and organizer answer 403, no token 401 (Task 2).
2. The run cap cannot be beaten by parallel `POST` calls (Task 2).
3. Every outcome of a buyer is counted exactly once, `doubleBookings` comes from SQL, not from the
   counters (Task 1).
4. A failing run never leaves the consumer stuck or the run RUNNING forever (Task 3).

---

### Task 1: Contracts, table, domain metrics, runner

**Files:**

- Create: `packages/shared/src/simulations.ts`, migration (generated),
  `apps/api/src/modules/simulations/domain/simulation-metrics.ts` (+ spec),
  `apps/api/src/modules/simulations/simulation-runner.ts` (+ `simulation-runner.db.spec.ts`),
  `apps/api/src/modules/simulations/index.ts`
- Modify: `packages/shared/src/index.ts`, `apps/api/src/infrastructure/database/schema.ts`,
  `docs/api/rest.md`, `docs/data-model.md`

**Interfaces (Produces):**

- Shared: `SIMULATION_STATUS = { QUEUED, RUNNING, FINISHED, FAILED } as const`;
  `SIMULATION_LIMITS = { BUYERS_MAX: 2000, SEATS_MAX: 500, BUYERS_DEFAULT: 500, SEATS_DEFAULT: 100 }`;
  `StartSimulationRequestSchema { buyers: int 1..BUYERS_MAX default 500, seats: int 1..SEATS_MAX
default 100, strategy }`; `SimulationMetricsSchema { attempts, holds, conflicts,
constraintViolations, retries, buyersDone, p50Ms, p95Ms: number ≥ 0; doubleBookings: int | null }`
  (null until the run ends); `SimulationProgressSchema { status, metrics }`;
  `SimulationRunSchema { id, eventId, strategy, buyers, seats, status, metrics, startedAt (ISO),
finishedAt (ISO|null) }`; `SimulationListResponseSchema` (array); `SimulationCommandSchema
{ runId: uuid }`; `SIMULATION_STREAM_KEY = 'simulations'`, `SIMULATION_CONSUMER_GROUP`,
  `simulationProgressKey(id)` is NOT shared (functions are not allowed there): the key builder lives in
  the module.
- Table `simulation_runs` (id uuid pk, event_id fk events cascade, strategy enum, buyers int, seats
  int, status enum `simulation_status`, metrics jsonb null, started_by uuid, started_at, finished_at
  null) with an index on `(status, started_at)` for the cap query.
- Domain: `percentile(values: readonly number[], p: number): number` (nearest rank, 0 for an empty
  list); `class SimulationMetricsRecorder { record(outcome: HoldOutcome, latencyMs: number, isRetry:
boolean): void; buyerDone(): void; snapshot(): Omit<SimulationMetrics, 'doubleBookings'> }`.
- `SimulationRunner` (injectable, in the module, no HTTP): `run(input: { runId, eventId, buyers,
seats: readonly string[], concurrency, onProgress(metrics): void }): Promise<SimulationMetrics>`.
  Needs `BookingsService`, `Clock`, a random source `() => number` (token, `Math.random` in the module
  wiring) and `intervalMs` for progress (250). Exported through `index.ts` with the module.

**Behavior rules:**

- Seat IDs for the run come from the event (read once); buyers pick a seat with the injected random
  source; each buyer is a synthetic `randomUUID()` user ID from an injected generator.
- At most `concurrency` buyers in flight (default `SIMULATION_CONCURRENCY` 40: below the API pool of
  20 the DB queue serializes buyers and `naive` stops racing, so the worker pool must allow it: set
  the worker's pool in the plan check, see Steps).
- PLACED → `holds`; SEAT_TAKEN → `conflicts`; CONSTRAINT_VIOLATION → `constraintViolations`. A
  buyer stops on PLACED, else picks another seat up to `MAX_ATTEMPTS_PER_BUYER`. Latency is the time
  of each `hold` call (Clock), recorded for every attempt.
- `onProgress` fires every `intervalMs` while running and once at the end; the final metrics add
  `doubleBookings` from `BookingsService.countDoubleBookings(eventId)`.

**Test cases:**

- `percentile`: empty list, one value, p50/p95 of a known list, unsorted input, p=100.
- Recorder: each outcome lands in exactly one counter; `attempts` equals the sum of outcomes;
  retries only counted when flagged.
- Runner (db, small numbers, concurrency 40, test pool 60): per strategy, 100 buyers on 5 seats:
  `naive` → doubleBookings > 0; pessimistic, optimistic, redis-lock → 0 and `constraintViolations`
  0 and `holds` ≤ 5. 10 buyers on 100 seats → holds 10, conflicts 0, retries 0. Buyers on 1 seat with
  `MAX_ATTEMPTS_PER_BUYER` 3 → attempts per buyer ≤ 3 (bounded). `concurrency` is never exceeded
  (a fake `hold` records the in-flight maximum). `onProgress` fires at least once during a slow run
  and last with `buyersDone === buyers`.
- Mutations that must turn a test red: final count hard-wired to 0 (naive test), remove the attempt
  bound (bounded test), remove the concurrency limit (in-flight test), count a conflict as a hold
  (recorder test).

**Steps:**

- [ ] Specs first (domain, then runner), watch them fail, implement, watch green.
- [ ] Contracts, table, `pnpm db:generate`, `docs/api/rest.md` (schemas only, endpoints come in
      Task 2), `docs/data-model.md` (table, ERD).
- [ ] Hand-mutate each guard above, record it in the commit body.
- [ ] Commits: `feat(shared): simulation contracts`, `feat(db): simulation runs [braucht
Live-Migration]`, `feat(api): simulation runner`.

---

### Task 2: API: start, read, list, stream

**Files:**

- Create: `apps/api/src/modules/simulations/simulations.controller.ts`,
  `simulations.service.ts`, `simulation-stream.service.ts`, `simulations.module.ts` and their
  `*.db.spec.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/infrastructure/rate-limit/rate-limit.decorator.ts`
  (`SIMULATION: { limit: 5, windowSeconds: 60 }`), `docs/api/rest.md`, `.env.example` only if a
  variable appears (none planned)

**Interfaces (Produces):**

| Method and path                   | Access | Result                                                                          |
| --------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `POST /api/simulations`           | admin  | 201 `SimulationRun` (QUEUED); 400 invalid body; 429 when two runs are active    |
| `GET /api/simulations`            | admin  | the 20 latest FINISHED runs, newest first                                       |
| `GET /api/simulations/:id`        | public | `SimulationRun`; 404 unknown                                                    |
| `GET /api/simulations/:id/stream` | public | SSE of `SimulationProgress`, ends after FINISHED or FAILED; 404 before it opens |

- `SimulationsService.start(input: StartSimulationRequest, adminId: string): Promise<SimulationRun>`;
  `find(id): Promise<SimulationRun>`; `listFinished(): Promise<SimulationRun[]>`.
- `SimulationStreamService.stream(runId): Observable<SimulationProgress>`: poll the progress key every
  250 ms (read the row when the key is absent), emit when the value changed, complete after a final
  status, complete after `STREAM_MAX_LIFETIME_MS`. Total open streams per process capped
  (`MAX_SIMULATION_STREAMS` 50, 503 above; `// shortcut:` per-process count, like the seat stream).

**Behavior rules:**

- `start`: one transaction under `pg_advisory_xact_lock`: count active runs in the window (cap 2, else
  `HttpException` 429 and nothing written); insert event (sandbox = admin), seats via
  `generate_series`, run row; after the commit `XADD simulations * runId <id>`. If `XADD` fails, mark
  the run FAILED and rethrow (no run stays QUEUED forever).
- Identity from the token only; `started_by` is `user.id`. The stream carries aggregates only.

**Test cases (auth lives in the controller spec):**

- start: customer 403, organizer 403, no token 401, admin 201; body outside the limits (0, 2001
  buyers, 501 seats, unknown strategy) 400; defaults apply to `{ strategy }`.
- start creates exactly M seats on a sandbox event owned by the admin, one run row QUEUED, one stream
  entry with the run ID; the event is not in the public event list.
- Cap: two active runs → third answers 429 and creates no event, row or entry; a run older than the
  timeout does not count; a FINISHED run does not count; 5 parallel starts with 0 active create
  exactly 2.
- XADD failure → run FAILED, error propagates.
- list: admin only, FINISHED only, newest first, at most 20. get: public, 404 unknown, invalid UUID 400. Rate limit: the sixth start in a minute answers 429.
- stream: unknown run 404 before any stream; emits the key's progress, completes after FINISHED;
  falls back to the row for a run the worker never started; total-cap 503; a malformed key value ends
  the stream with an error (fail fast, no fallback data).
- Mutations: remove `@Roles(ROLE.ADMIN)` (the forbidden-role cases), remove the advisory lock (parallel test),
  drop the window filter (timeout test), drop the cap (cap test).

**Steps:** specs, implement, `pnpm test:db`, REST docs. Commits: `feat(api): start and read
simulations`, `feat(api): simulation progress stream`.

---

### Task 3: Worker consumer

**Files:**

- Create: `apps/worker/src/simulation.consumer.ts` (+ `simulation.consumer.db.spec.ts`)
- Modify: `apps/worker/src/worker.module.ts` (imports `SimulationsModule` from
  `@app/api/simulations`; check the path alias and `package.json` exports, add the entry like the
  existing ones), `docs/BACKLOG.md` later in Task 5

**Behavior rules:**

- On start: `XGROUP CREATE simulations <group> $ MKSTREAM` (ignore only BUSYGROUP), then loop
  `XREADGROUP` with a blocking read on its own duplicated Redis connection; one run at a time per
  worker. Shutdown ends the loop and closes the connection (no dangling blocking read).
- Per message: parse `SimulationCommandSchema`; set the row RUNNING; read the event's seats; call
  the runner with `onProgress` writing the progress key (`SET ... EX 3600`); store FINISHED with the
  final metrics and `finished_at`; write the final progress; `XACK`.
- Malformed message or unknown run: log (IDs only), `XACK`. Runner failure: row FAILED with
  `finished_at`, final progress key with FAILED, log the error name, `XACK`. A failing loop iteration
  (Redis error) is logged and retried after a pause; it never ends the process or the loop silently.
- No personal data: the logs carry run IDs only.

**Test cases (real Redis and Postgres):**

- A queued run is picked up, ends FINISHED with metrics in the row and `buyersDone === buyers`, the
  message is acknowledged (no pending entry), the progress key holds the FINISHED payload.
- Runner failure (a `BookingsService` fake that throws) → FAILED, acknowledged, the next message
  still runs.
- Malformed entry and unknown run ID → acknowledged, logged, the consumer keeps going.
- Two consumers in the same group take two different runs and never the same one twice.
- Shutdown during a blocking read returns without a hang.
- Mutations: remove `XACK` (pending test), remove the FAILED branch (failure test), process without
  the group (two-consumer test).

**Steps:** specs, implement, `pnpm test:db`. Then bring up the stack (`docker compose up --build
-d`, `df -h` first), log in as admin, run `naive` and one other strategy through the API with default
numbers and confirm double bookings above zero for `naive` and zero otherwise. If `naive` shows zero
with the worker's pool size, raise the worker pool in `DatabaseModule` through the config (one
documented constant) and note it in the commit. Commit: `feat(worker): consume simulation runs`.

---

### Task 4: Web dashboard

**Files:**

- Create under `apps/web/src/app/admin/`: `simulator.service.ts` (HttpClient + stream, services only),
  `simulator.store.ts` if state needs it, `simulator-page.ts/.html`, specs
- Modify: `apps/web/src/app/app.routes.ts` (`/admin/simulator`, `roleGuard(ROLE.ADMIN)`), header link
  for admins

**Behavior:** Start form (buyers, seats, strategy select; defaults 500, 100; limits from
`SIMULATION_LIMITS`, native validation message), live counters for the current run (status as text,
attempts, holds, conflicts, retries, double bookings, p50, p95, buyers done as a progress element),
and a comparison table of finished runs (strategy, buyers, seats, holds, conflicts, double bookings,
p95), with `GET /api/simulations` loaded on entry and the finished run added when the stream ends.
The stream uses `EventSource` wrapped in an Observable like `seat-stream.service.ts`; completion on
FINISHED/FAILED closes it. States: loading and empty (no runs yet) for the table, error with retry
for the list and for a failed start, 429 shown as "two runs are active, try again shortly", pending
(start disabled while a run is active, no double submit), FAILED run shown with its own message. A
double-booking count above zero is shown by text, not color alone. Semantic tokens only.

**Test cases (`ng test`):** the form sends the chosen values once (double click sends one request);
429 shows the busy message; counters update from stream messages; a FINISHED message closes the
stream and adds a table row; FAILED shows the failure message; list empty, loading, error with retry;
the route is refused for customer and organizer (guard spec exists, add the admin route case).
Mutations: ignore stream completion (row test dies), drop the pending flag (double-submit test dies).

**Steps:** specs, implement, then inspect in a browser as admin (chrome-devtools MCP): start a
`naive` run and a `pessimistic` run, check live counters, the table, a 429 (start three), keyboard
use, narrow width. Commit: `feat(web): simulator dashboard`.

---

### Task 5: End-to-end, docs, phase 1 check

**Files:**

- Create: `apps/web/e2e/simulator.e2e.ts`
- Modify: `README.md`, `docs/api/rest.md`, `docs/BACKLOG.md`, `CONTRIBUTING.md` if the worker or
  commands changed, this plan's ledger

**Steps:**

- [ ] Playwright: admin demo login, open the simulator, start a small `pessimistic` run (for example
      100 buyers, 20 seats), wait for "Finished", assert double bookings 0 and one table row. The
      `naive` comparison is pinned by the runner spec (lowest layer), not repeated here. Run
      `pnpm e2e`.
- [ ] README: simulator in the requirements and the API table, architecture diagram gets the
      worker's stream consumer. BACKLOG: slice D state, deviations (no `eventId`, row-based cap,
      progress key instead of pub/sub), open points (crashed-worker message stays pending, old
      simulation events are not cleaned, simulation stream caps are per process).
- [ ] Phase 1 Definition of Done check against [PLAN.md](../../PLAN.md#phase-1-core), each line with
      its evidence: demo login for all roles with server-side role tests; simulator naive above
      zero and the others zero as automated test; two-tab live update; CI green; README has
      requirements, entities, API and the architecture diagram. Report gaps instead of papering over
      them.
- [ ] Final whole-branch review with the strongest model (cap, auth, consumer failure paths), fix
      wave, `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm e2e` green, push, check CI.
- [ ] DoD receipt per feature in the final report, ledger filled, one summary line.

---

## Execution

Dispatch with `umsetzer` (medium model from `CLAUDE_CODE_SUBAGENT_MODEL`, no `model` set). Bundles:
**1**, **2+3**, **4**, **5**. Own review (`pruefer`) after **2+3** only (admin gate, run cap,
consumer failure paths); the rest get the group check and the final whole-branch review on the
strongest model.

## Ledger

| Task                           | Duration   | Subagent tokens | Notes                                                                  |
| ------------------------------ | ---------- | --------------- | ---------------------------------------------------------------------- |
| 1                              | 2165 s     | 126.7k          |                                                                        |
| 2+3                            | 1737 s     | 237.1k          |                                                                        |
| Review 2+3                     | 124 s      | 71.9k           |                                                                        |
| Fix wave                       | 675 s      | 132.7k          |                                                                        |
| 4                              | 734 s      | 156.3k          |                                                                        |
| 5                              | 804 s      | 95.6k           | e2e spec, docs, phase 1 check                                          |
| Final review (strongest model) | 350 s      | 97.9k           | approved; web 429 message, destroy-bound subscription, backlog entries |
| Follow-up fixes                | n/a        | n/a             |                                                                        |
| **Sum**                        | **6589 s** | **918.2k**      | agent time; follow-up fixes not included                               |
