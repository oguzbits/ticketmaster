# Phase 2, slice C: several API instances, PgBouncer, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The API runs as two replicas behind Caddy and every database connection goes through PgBouncer; the stream caps hold across replicas.

**Architecture:** Per-process stream counters move to Redis as expiring slots (a sorted set per limit, scored by expiry time from the injected `Clock`), so a crashed process frees its slots by itself. PgBouncer runs in transaction mode; the API and the worker connect through it, `migrate` and the db-spec setup connect directly. Caddy finds the replicas by DNS (`dynamic a`) and retries a failed connection on the other one.

**Tech Stack:** NestJS, node-redis, postgres.js, Drizzle, PgBouncer, Caddy 2.11, Docker Compose, Playwright, Vitest.

**Spec:** [Phase 2 design, slice C](../specs/2026-11-13-phase-2-async-and-scaling-design.md)

## Global Constraints

- Two `api` replicas; the worker stays one instance. Rate limits and seat fan-out already use Redis (unchanged).
- Behavior of the caps does not change: a seat stream over the total cap answers 503, over the per-address cap 429 (total is checked first); a simulation stream over its cap answers 503. Values stay `MAX_STREAMS_PER_IP = 10`, `MAX_STREAMS_TOTAL = 500` (now for all replicas together), `MAX_SIMULATION_STREAMS = 50` (all replicas together).
- Time only from the injected `Clock` (`CLOCK`); no `Date.now()` in new code.
- No fallback when Redis fails: the error propagates (fail fast).
- AGENTS.md applies: no `vi.mock`, no `any`, constants as `as const` dictionaries, env only through the config module, English docs, Conventional Commits straight on `main`, hooks never skipped. Run `df -h` before the first image build.
- Verify the current docs before pinning any image or using any Caddy or PgBouncer option (AGENTS.md rule 9).

## Review Focus

- A stream slot is freed on every way a stream ends (complete, error, client abort, lifetime): a leak in Redis would block an address for good. Test: a slot is gone after abort, and a slot of a vanished process expires on its own.
- Two replicas starting streams at the same moment must not both pass a cap of one: the check and the add are one atomic Redis step.
- A prepared statement or a session setting that PgBouncer in transaction mode would break (`set_config(..., true)` is transaction-local and is fine; check the driver option).
- A replica that stops while requests arrive: a GET through Caddy still answers 200 and no seat stream is lost for good (the client reconnects).
- The first request after a replica starts or stops: Caddy has to see the new address list within seconds.

---

### Task 1: Slot limiter in Redis

**Files:**

- Create: `apps/api/src/infrastructure/rate-limit/slot-limiter.ts`
- Create: `apps/api/src/infrastructure/rate-limit/slot-limiter.db.spec.ts`
- Modify: `apps/api/src/infrastructure/rate-limit/rate-limit.module.ts` (provide and export `SlotLimiter`)

**Interfaces:**

- Produces:

  ```ts
  @Injectable() export class SlotLimiter {
    constructor(@Inject(REDIS) redis: Redis, @Inject(CLOCK) clock: Clock)
    /** true and the slot is held until `lifetimeMs` from now; false when `limit` live slots exist. */
    acquire(key: string, slotId: string, limit: number, lifetimeMs: number): Promise<boolean>
    release(key: string, slotId: string): Promise<void>
  }
  ```

- [ ] **Step 1: Write the failing spec** (`slot-limiter.db.spec.ts`, own key per test): `refuses the slot above the limit and accepts it again after a release`; `counts only live slots: a slot past its lifetime no longer counts (advance a fake Clock)`; `acquiring the same slotId twice holds one slot`; `ten parallel acquires with limit 3 let exactly 3 in`; `release of an unknown slot is a no-op`.
- [ ] **Step 2: Run** `pnpm test:db -- slot-limiter` (needs `pnpm db:up`). Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `SlotLimiter` with one Lua script per method (atomic, like `HIT_SCRIPT` in `rate-limiter.ts`): `acquire` removes slots scored below `now`, returns 1 when the slot is already a member or `ZCARD < limit` (then `ZADD` with score `now + lifetimeMs`), else 0; the key also gets a `PEXPIRE` of `lifetimeMs` so an idle key disappears. Parse the reply with Zod like `HitReplySchema`.
- [ ] **Step 4: Run again.** Expected: PASS. Break it by hand: change `<` to `<=` in the script and `Clock` use to a constant; the matching tests must fail; restore.
- [ ] **Step 5: Commit** `feat(rate-limit): redis slot limiter for open streams`

### Task 2: Stream caps use the slot limiter

**Files:**

- Modify: `apps/api/src/modules/events/seat-stream.service.ts` (remove `streamsPerIp`, `streamsTotal`, `admit`, `release`; `stream()` becomes `async stream(...): Promise<Observable<SeatStreamMessage>>`; inject `SlotLimiter` and `CLOCK`)
- Modify: `apps/api/src/modules/events/seat-stream.controller.ts` (await it), `apps/api/src/modules/simulations/simulation-stream.service.ts` and `simulations.controller.ts` likewise
- Modify: `seat-stream.service.db.spec.ts`, `simulation-stream.service.db.spec.ts` (construct with a `SlotLimiter`), the module files if providers are needed

**Interfaces:**

- Consumes: `SlotLimiter` from Task 1 (import through the rate-limit module's `index.ts` or the module that exports it; follow the existing import pattern of `RateLimiter`).
- Keys: `streams:seat:total`, `streams:seat:ip:<address>`, `streams:simulation:total`. Slot id: a `randomUUID()` per stream. Slot lifetime: `maxLifetimeMs + 60_000` (a constant `SLOT_SLACK_MS`).

- [ ] **Step 1: Update the existing cap specs** (they must keep their meaning: 429 per address, 503 total, slot freed on disconnect, other addresses unaffected) and add: `a second service instance sharing the Redis counts against the same cap` (two services, `maxStreamsTotal = 2`, one stream each, the third is refused with 503 on either) and `a slot is freed when a stream errors` (snapshot failure).
- [ ] **Step 2: Run** `pnpm test:db -- seat-stream simulation-stream`. Expected: new tests FAIL (caps are per instance), old ones may fail on the signature.
- [ ] **Step 3: Implement.** Order in the seat stream: acquire total (503), then address (429; release the total slot first). Release both when the Observable ends, in the existing teardown. Remove both `shortcut:` comments. `stream()` may await before it returns the Observable, so a refusal is still a status code.
- [ ] **Step 4: Run** the two specs plus `seat-stream.controller.db.spec.ts` and `simulations.controller.db.spec.ts`. Expected: PASS. Hand check: remove the release in the teardown; the freed-slot tests must fail.
- [ ] **Step 5: `pnpm check`**, then commit `feat(streams): share the stream caps between API instances through redis`

### Task 3: Two API instances in one spec

**Files:**

- Create: `apps/api/src/modules/events/seat-stream.cluster.db.spec.ts`

Boot two `AppModule` apps (the pattern of `seat-stream.controller.db.spec.ts`: `Test.createTestingModule`, `configureApp`, `listen(0)`, fake token verifier) against the same database and Redis.

- [ ] **Step 1: Write the spec:** `a hold made through instance A reaches a stream open on instance B` (customer holds a seat on A with a bearer token; B's stream delivers the change event with that seat as `HELD`); `the per-address cap holds across both instances` (set `maxStreamsPerIp = 2` on both services; two streams on A plus one on B from one address: the third answers 429; another address is accepted).
- [ ] **Step 2: Run.** Expected: PASS (Tasks 1 and 2 are done). Hand check: make the seat-stream cap local again for one run; the second test must fail. Restore.
- [ ] **Step 3: Commit** `test(events): two api instances share seat changes and stream caps`

### Task 4: PgBouncer

**Files:**

- Create: `docs/adr/0005-pgbouncer-transaction-mode.md` (MADR, from `0000-template.md`)
- Modify: `docker-compose.yml` (service `pgbouncer`; `api` and `worker` use `postgres://app:app@pgbouncer:6432/app`; `migrate` stays on `postgres:5432`), `apps/api/src/infrastructure/database/database.module.ts` (driver option), `package.json` (`db:up` starts `pgbouncer`), `.github/workflows/*.yml` (the db-test job starts PgBouncer as a service or container and exports its URL), `.env.example`, `docs/data-model.md` if it names connection settings

- [ ] **Step 1: Choose and prove, then write the ADR.** There is no official image; compare the maintained community images (tag list, last release, licence, arm64) and pick one by evidence. Read the PgBouncer docs for the current version: whether prepared statements work in transaction mode (`max_prepared_statements`) and what the `auth` setup needs for Postgres 18 (SCRAM). Record the decision, the pool sizes (`default_pool_size` derived from 2 × `API_POOL_SIZE` + the worker's connections, with headroom below Postgres' `max_connections`) and the rejected options (session mode, no pooler) in the ADR. Status accepted only after Step 3 passes.
- [ ] **Step 2: Wire it.** Pool mode `transaction`; the postgres.js option `prepare: false` unless Step 1 shows the chosen version supports protocol-level prepared statements and the setting is on; give the pgbouncer service a healthcheck and make `api` and `worker` wait for it.
- [ ] **Step 3: Prove it with the existing suite.** Point `DATABASE_URL` of the db specs at PgBouncer (host `localhost`, the published port) while `db-global-setup.ts` keeps creating and migrating `app_test` directly (it takes a separate direct URL; add `DATABASE_ADMIN_URL`, optional, falling back to `DATABASE_URL`, through the config module only if setup cannot work otherwise). Run `pnpm test:db`. Expected: all pass, including the concurrency test with zero double bookings except `naive`. Any failure from a session-level feature is fixed in the code, not by switching the pool mode.
- [ ] **Step 4: Gegenprobe.** Run the pessimistic concurrency spec once with the pool in `statement` mode (a temporary local change); it must fail, which shows the spec exercises the transaction boundary. Restore.
- [ ] **Step 5: CI.** The db-test job uses PgBouncer too; `gh run list --branch main --limit 1` must be green after the push.
- [ ] **Step 6: Commit** `feat(infra): pgbouncer in transaction mode between the apps and postgres` (message names the image choice and why).

### Task 5: Replicas behind Caddy, failover, docs

**Files:**

- Modify: `apps/web/Caddyfile`, `docker-compose.yml` (`api: deploy: { replicas: 2 }`), `docker-compose.e2e.yml` if needed
- Create: `apps/web/e2e/failover.e2e.ts`; modify `apps/web/e2e/playwright.config.ts` so it runs after all other specs (a project that depends on the others, or the config's ordering; check the config)
- Modify: `docs/BACKLOG.md`, `README.md` (architecture and the run command), `docs/PLAN.md` only if it states something now untrue

- [ ] **Step 1: Caddy.** Both `reverse_proxy api:3000` blocks become a shared upstream definition (a snippet) with `dynamic a` for host `api`, port 3000 and a short refresh (read the Caddy 2.11 docs for the exact syntax and the required module), `lb_policy round_robin`, `lb_try_duration` of a few seconds so a refused connection is retried on the other replica, and a passive failure window. Keep `flush_interval -1` on `/api/*`.
- [ ] **Step 2: Write the failing e2e spec:** `the app keeps answering when one api replica stops`: through port 8080 `GET /health/ready` answers 200 twenty times; stop one replica (`docker stop` of the first id from `docker compose ps -q api`, the project name comes from the environment `scripts/e2e.mjs` sets); `GET /health/ready` answers 200 for ten seconds without a single failure; the public event list still loads in the browser. Before Step 1 it fails (one upstream is gone).
- [ ] **Step 3: Run** `pnpm e2e`. Expected: all specs pass, including the existing live-seats spec with two replicas up. Hand check: remove `lb_try_duration`; the failover spec must fail.
- [ ] **Step 4: Docs.** BACKLOG: add the slice C state block; delete the open points "The seat-stream caps are per process" and "The simulation stream caps are per process"; add: slots of a vanished process expire after the stream lifetime plus slack; the worker is a single instance; the pool numbers live in ADR 0005. README: two replicas and PgBouncer in the architecture text and diagram.
- [ ] **Step 5: `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm e2e` green, push, `gh run list --branch main --limit 1` green.** Commit `feat(infra): two api replicas behind caddy` and `docs: slice C state and open points` as separate commits.
- [ ] **Step 6: Stop and report** (state, deviations, open points) per AGENTS.md; add the ledger line (duration, subagent tokens per task, total) to this plan's end.

## Out of scope

Waiting room (slice D), infrastructure as code (slice E), autoscaling, several workers, health-based removal in PgBouncer, replacing the AWS emulator.

## Ledger

Native run in one session: tasks 1 to 5 plus one whole-branch review (strongest model, 93,584
subagent tokens, 5 min) and one fix pass. Task 4 and the final fix were pushed with a green CI run
each; `pnpm e2e` ran four times (red, green, mutation, task-done). No implementer subagents.
