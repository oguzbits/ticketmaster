# Phase 3, slice D: k6 and the event page cache, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put numbers on the system with k6 (browse, booking flow, rush per strategy, waiting room), then add a Redis cache for the public event list and the event layout and show its effect with a before/after run.

**Architecture:** A generic `CacheAside` (infrastructure, Redis, Zod-validated reads, fails open, counts hit/miss/error through `BusinessMetrics`) is used by a small module `event-cache` that owns the keys, the TTL and the invalidation. `EventsService` caches only what is public and static (event summaries, seat layout); seat status is always read live. The three writers of public event rows (`setStrategy`, `setCapacity`, organizer create) invalidate after their commit. k6 runs as a Compose service (profile `loadtest`) against `web:8080`; scripts live in `scripts/k6/`, results in `docs/load-tests.md`.

**Tech Stack:** NestJS, `redis` (node-redis, already installed), Zod, OpenTelemetry meter, Grafana dashboard JSON, k6 (`grafana/k6` image), Docker Compose.

**Spec:** [Phase 3 design, slice D](../specs/2026-11-14-phase-3-observability-and-measuring-design.md#slice-d-k6-and-the-event-page-cache)

## Global Constraints

- AGENTS.md applies: no `vi.mock`, no `any`, no `as unknown as`, no `export *`, no `unknown` as a parameter or return type (parse with Zod), relative imports end in `.js`, modules import each other through `index.ts`, `// SAFETY:` on every assertion except `as const`, English docs, Conventional Commits straight on `main`, one topic per commit, hooks never skipped, `pnpm check` green before every commit, docs in the same commit as the code (docs-map).
- **Seat status and anything user-owned never go through the cache.** Only events with `sandbox_user_id is null` are cached; a miss for a sandbox or unknown event is not cached (no negative entries).
- Redis failure on read or write: fall through to PostgreSQL, log the error message and the key (IDs only, no personal data). This is the one explicit fail-open path; say so in the code comment.
- Invalidation runs **after** the commit of the change. A failed invalidation is logged, not thrown (the write is already committed); the TTL bounds the staleness.
- TTL: `EVENT_CACHE_TTL_SECONDS`, default 30, `0` switches the cache off (baseline runs). Read through `apps/api/src/config` only; add to `.env.example`.
- Metric `tm.cache.requests` (counter), labels `cache` (`events.list` | `events.detail`) and `result` (`HIT` | `MISS` | `ERROR`). No per-event or per-user label.
- k6: results are never a CI gate; every result in `docs/load-tests.md` states date, hardware, command and numbers. Load tests never run against anything but the local Compose stack.
- Load-test mode only through `docker-compose.loadtest.yml` (payment failure rate 0, `RATE_LIMIT_SCALE=1000`); the default stack keeps `RATE_LIMIT_SCALE=1`.
- Free disk was 16 GiB at planning time (spec assumed about 20): run `df -h` before pulling images and report if below 10 GiB.

## Review Focus

- A sandbox event of user A must never be served to anonymous or to user B from the cache, in the list or in the detail (Task 3).
- A garbage or old-shape value under a cache key counts as a miss, is replaced, and does not 500 (Task 1).
- A cached layout must not show a stale seat status: book a seat, read the detail again within the TTL, the seat is `HELD` (Task 3).
- Invalidation on a strategy switch: the list shows the new strategy at once, not after the TTL (Task 3).
- A load run that gets 429s measures the rate limiter, not the system: the k6 checks count 429 as a failure (Task 4).

## File structure

| Path                                                     | Responsibility                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/api/src/infrastructure/cache/`                     | `cache-aside.ts`, `cache.module.ts`, `index.ts`                                      |
| `apps/api/src/modules/event-cache/`                      | `event-cache.ts` (keys, TTL, `EventCache`), `event-cache.module.ts`, `index.ts`      |
| `apps/api/src/core/business-metrics.ts`                  | `cacheLookup`, `CACHE_RESULT`                                                        |
| `apps/api/src/infrastructure/metrics/`                   | `METRIC.CACHE_REQUESTS`, `METRIC_ATTR.CACHE` / `RESULT`, counter in the OTel adapter |
| `apps/api/src/modules/events/events.service.ts`          | `list` and `detail` read through `EventCache`                                        |
| `apps/api/src/modules/organizer`, `modules/waiting-room` | call `EventCache.invalidate` after their commit                                      |
| `apps/api/src/infrastructure/rate-limit/`                | `RATE_LIMIT_SCALE` applied to every limit                                            |
| `docker-compose.loadtest.yml`, `scripts/k6/`             | override, `k6` service, scenarios, `run.mjs`; `pnpm load` in `package.json`          |
| `docs/load-tests.md`                                     | scenarios, thresholds, results                                                       |

## Interfaces (exact signatures)

```ts
// core/business-metrics.ts
export const CACHE_RESULT = { HIT: 'HIT', MISS: 'MISS', ERROR: 'ERROR' } as const;
export type CacheResult = (typeof CACHE_RESULT)[keyof typeof CACHE_RESULT];
// BusinessMetrics gains:
cacheLookup(cache: string, result: CacheResult): void;

// infrastructure/cache/cache-aside.ts
@Injectable()
export class CacheAside {
  /** ttlSeconds 0: no Redis call, no metric, just `load`. null from `load` is returned and not stored. */
  getOrLoad<S extends z.ZodType>(
    cache: string, key: string, schema: S, ttlSeconds: number,
    load: () => Promise<z.infer<S> | null>
  ): Promise<z.infer<S> | null>;
  /** Never throws; a Redis error is logged. */
  invalidate(...keys: string[]): Promise<void>;
}

// modules/event-cache/event-cache.ts
export const EVENT_CACHE = { LIST: 'events.list', DETAIL: 'events.detail' } as const;
@Injectable()
export class EventCache {
  list(load: () => Promise<EventSummary[]>): Promise<EventSummary[]>;
  detail(id: string, load: () => Promise<EventLayout | null>): Promise<EventLayout | null>;
  /** List key and the detail key of `eventId`. */
  invalidate(eventId: string): Promise<void>;
}
// EventLayout = EventSummary plus seats without status (EventLayoutSchema, Zod, in event-cache.ts)
```

## Tasks

### Task 1: `CacheAside`, the metric and the TTL setting

**Files:** create `infrastructure/cache/*`; modify `core/business-metrics.ts`, `infrastructure/metrics/{names,otel-business-metrics,observability-files.spec}.ts`, `config/env.ts`, `.env.example`, `docs/observability.md`.

**Interfaces:** Produces `CacheAside`, `CACHE_RESULT`, `METRIC.CACHE_REQUESTS = 'tm.cache.requests'`, env `EVENT_CACHE_TTL_SECONDS` (`z.coerce.number().int().min(0).default(30)`).

- [ ] Tests in `cache-aside.db.spec.ts` (real Redis via `pnpm db:up`, a recording `BusinessMetrics` fake): `miss then hit calls load once`, `null from load is not stored`, `ttl 0 never touches redis and counts nothing`, `a value that fails the schema counts MISS, is replaced and returns the loaded value`, `a closed redis client falls through to load, counts ERROR and does not throw`, `invalidate deletes the keys`, `invalidate on a closed client resolves`.
- [ ] Run them, expect FAIL (module missing).
- [ ] Implement `CacheAside` (JSON string with `EX`; `schema.safeParse(JSON.parse(raw))`; every Redis call in one try/catch that logs `{ key, message }` with the Nest `Logger`). Add the counter to `OtelBusinessMetrics`, the `METRIC_KIND` entry (`COUNTER`) in `observability-files.spec.ts`, one paragraph on `tm.cache.requests` in `docs/observability.md#metrics`, the env variable and `.env.example`.
- [ ] Hand mutation: make the fall-through rethrow, a test must die; drop `EX`, a test must die (use the TTL assertion `ttl > 0` in the hit test).
- [ ] `pnpm test`, `pnpm check`; commit `feat(cache): cache-aside on Redis with hit and miss metrics`.

### Task 2: `RATE_LIMIT_SCALE` for load runs

**Files:** modify `infrastructure/rate-limit/rate-limit.guard.ts`, `config/env.ts`, `.env.example`, `rate-limit.guard.spec.ts`.

**Interfaces:** Produces env `RATE_LIMIT_SCALE` (`z.coerce.number().int().min(1).default(1)`); the effective limit is `limit * scale`.

- [ ] Test: with scale 3 the guard lets `DEFAULT.limit * 3` requests through and refuses the next with 429; with scale 1 it refuses at `DEFAULT.limit`. Expect FAIL, implement, expect PASS.
- [ ] Hand mutation: ignore the scale, the scale-3 test must die.
- [ ] `pnpm check`; commit `feat(rate-limit): scale the limits for load runs`. Say in the commit that the default is 1 and only `docker-compose.loadtest.yml` raises it.

### Task 3: Event cache wiring (touches visibility: gets its own review)

**Files:** create `modules/event-cache/*`; modify `events.service.ts`, `events.module.ts`, `organizer.service.ts` + module, `waiting-room.service.ts` + module, the matching `*.db.spec.ts`.

**Interfaces:** Consumes `CacheAside`. Produces `EventCache` (above). `EventsService.list(userId)` returns public events from `EventCache.list` plus, only when `userId !== null`, the caller's sandbox events from PostgreSQL, sorted by `startsAt` then as before. `EventsService.detail(id, userId)`: layout from `EventCache.detail` (loader selects only `sandbox_user_id is null`; returns `null` otherwise); on `null` fall back to the uncached sandbox query for `userId`, else `NotFound`. Seat status: one live query `select seat_id, max(status) from bookings where event_id = $1 and status in ACTIVE group by seat_id` merged onto the layout, same enum-order rule as today (`HELD < PAID < CONFIRMED`).

- [ ] Tests first, in `events.controller.db.spec.ts` unless noted (real Redis, `subscribeQueryCounter` as the counting adapter):
  - `second list request runs no event query` (counter delta 0 for the events table).
  - `second detail request runs only the status query`.
  - `a hold shows in the next detail within the TTL` (cached layout, live status `HELD`).
  - `strategy switch shows in the list at once` (guard: remove the `invalidate` call in `setStrategy`, this test must die).
  - `waiting room capacity change shows in the list at once` and `a new public event shows in the list at once` (organizer spec; same guard rule for their `invalidate` calls).
  - `a sandbox event is served only to its owner, from the database`: owner reads list and detail, anonymous and another demo user get no entry / 404, and `redis keys events:*` holds no key naming the sandbox event.
  - `a closed redis client still answers list and detail` (fail open).
  - Existing seat-status specs (NAIVE with several active bookings picks the furthest status) stay green unchanged.
- [ ] Expect FAIL, implement, expect PASS. `EventCache.invalidate` is called after the transaction returns in the three writers.
- [ ] Hand mutations: serve sandbox rows through the cache loader; skip each `invalidate`; cache the status. Each must kill a test.
- [ ] `pnpm test`, `pnpm check`; commit `feat(events): cache the public event list and layout in Redis`. Dispatch `pruefer` on this commit before Task 4.

### Task 4: k6 scenarios and the runner

**Files:** create `docker-compose.loadtest.yml`, `scripts/k6/{lib,browse,booking-flow,rush,waiting-room}.js`, `scripts/k6/run.mjs`; modify `package.json` (`"load": "node scripts/k6/run.mjs"`), `docs/docs-map.json` (`"scripts/k6/": "docs/load-tests.md"`, `"docker-compose.loadtest.yml": "docs/load-tests.md"`), ESLint config for `scripts/k6/**` (k6 globals, imports from `k6/*`), knip config if it flags the scripts.

**Interfaces:** `pnpm load <browse|booking-flow|rush|waiting-room|all>` brings the stack up with both compose files (`up -d --build --wait`, same style as `scripts/e2e.mjs`), runs `docker compose --profile loadtest run --rm k6 run /scripts/<name>.js`, and leaves the stack up (`pnpm load:down` is not added; `docker compose down` as in the docs). The `k6` service uses `grafana/k6:<tag>` (read the current stable tag from the registry, AGENTS rule 9), mounts `scripts/k6`, `BASE_URL=http://web:8080`. `lib.js` exports `login(role): { accessToken }` (`POST /api/demo-login`), `auth(token)`, `findEvent(predicate)` (`GET /api/events`, no event IDs hard-coded; pick by `strategy` and `waitingRoomCapacity !== null`) and `ok(res, status)` that fails a check on 429.

- [ ] `browse.js`: `constant-arrival-rate` 200 req/s for 60 s on `GET /api/events` and `GET /api/events/:id`; thresholds `http_req_failed: rate<0.01`, `http_req_duration: p(95)<300`.
- [ ] `booking-flow.js`: setup logs in 40 customers; each iteration holds a free seat of the PESSIMISTIC event (from the detail), pays with a UUID in the idempotency header (header name from `IDEMPOTENCY_KEY_HEADER` in `packages/shared`, copy the string into `lib.js` with a comment naming it), cancels nothing; thresholds `http_req_failed: rate<0.01` (a `409` on an already-taken seat counts as expected, not failed: `setResponseCallback`), `http_req_duration{name:hold}: p(95)<500`, `{name:pay}: p(95)<1000`.
- [ ] `rush.js`: one scenario per strategy (4 sequential `startTime`s), 50 customers per scenario hold the **same** seat at the same time, repeated for 10 seats; custom `Counter double_bookings` = (201 responses of one seat) − 1, tagged by strategy. Thresholds: `double_bookings{strategy:PESSIMISTIC}`, `OPTIMISTIC`, `REDIS_LOCK`: `count==0`; NAIVE has none (it is the comparison).
- [ ] `waiting-room.js`: 100 customers join the event with a waiting room, poll `GET` every second up to 20 s, leave with `DELETE`; thresholds `http_req_failed: rate<0.01`, `p(95)<300` on join and poll.
- [ ] Verify each scenario once (`pnpm load browse` etc.); expect thresholds green or a recorded, explained miss; a run with any 429 is a bug in the setup, not a result.
- [ ] `pnpm check`; commit `feat(load): k6 scenarios and runner`.

### Task 5: Baseline, cache run, dashboard panel, document

**Files:** create `docs/load-tests.md`; modify `docker/observability/grafana/provisioning/dashboards/api.json`, `docs/observability.md`, `README.md` (one line), `docs/BACKLOG.md`, `docs/PLAN.md` only if context changed.

- [ ] Add a stat/timeseries panel `Event cache hit ratio` to the `API` dashboard: `sum(rate(tm_cache_requests_total{result="HIT"}[5m])) / sum(rate(tm_cache_requests_total{result=~"HIT|MISS"}[5m]))`; `observability-files.spec.ts` must stay green; update the dashboard paragraph in `docs/observability.md`.
- [ ] Baseline: `EVENT_CACHE_TTL_SECONDS=0 pnpm load all`, then cache on (default): `pnpm load browse`. Run each twice, keep the second (warm images). Start with `METRICS_ENABLED=true` and the `observability` profile for the browse pair so the hit ratio is visible; read the hit ratio from Prometheus (`curl` the query API) and note it.
- [ ] `docs/load-tests.md`: hardware (`sysctl -n machdep.cpu.brand_string`, `sysctl -n hw.memsize`, Docker memory limit), date, commands, one table per scenario with p50/p95/p99, throughput, error rate; the before/after table for `browse` with the hit ratio; limits ("single machine, the load generator shares the CPU with the system under test", "payment failure rate 0 and rate limits scaled by 1000").
- [ ] Backlog: slice D done, phase 3 done; open points for the cache (stale up to the TTL after a race between a reader and a commit; seeds are not invalidated; a sandbox user pays one extra query). Remove the "Next: slice D" text.
- [ ] `pnpm check`, `pnpm test`, `pnpm e2e` (the default stack must still pass with the cache on); commit `docs(load): k6 results and the cache effect`; push; `gh run list --branch main --limit 1` until green.
- [ ] Final whole-slice review (`pruefer`), DoD receipt in the final report, stop and report per AGENTS phase rule. Tell the user to `/clear`.

## Ledger (fill while executing)

| Task | Duration | Subagent tokens | Notes |
| ---- | -------- | --------------- | ----- |

## Self-review notes

- Spec coverage: scenarios (Task 4), baseline then cache (Task 5), cache-aside with TTL and explicit invalidation (Tasks 1, 3), hit/miss metric and dashboard (Tasks 1, 5), the four test claims and the invalidation guard (Task 3), docs (all).
- Deviation from the spec text: the rush scenario drives the seeded per-strategy public events with parallel customers instead of the sandbox simulator, because only a public event is visible to many customers.
- Not done on purpose: negative caching, a cache for bookings or user data, load tests in CI.
