# Phase 1, slice A: data model, booking strategies, hold expiry. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Postgres schema with the booking state machine, holds under four strategies with a
concurrency test, fake payment, hold expiry in the worker, and a read-only event list and seat map
in the web app.

**Architecture:** The bookings module holds a pure state machine in its `domain/` folder and one
`SeatReservation` adapter per strategy. A shared database and Redis infrastructure sits in the API
under `src/infrastructure`. The worker reuses the bookings module through package exports of
`@app/api` and runs the hold-expiry job.

**Tech Stack:** NestJS 12, drizzle-orm 0.45 (stable) with drizzle-kit 0.31 and `postgres`
(postgres.js) 4, `redis` (node-redis) 6, nestjs-pino 5 with pino 10 and pino-http 11,
@nestjs/schedule 12, Vitest 5, Angular 22 with Tailwind.

**Spec:** [phase 1 design](../specs/2026-11-13-phase-1-core-design.md), section "Slice A". Rules:
[AGENTS.md](../../../AGENTS.md).

## Global Constraints

- Every rule in AGENTS.md applies: `.js` import suffixes, no `any`/`unknown` parameters, `// SAFETY:`
  on assertions, dictionaries for every steering value, no `vi.mock`, no `console`, no
  `process.env` outside `src/config`.
- Domain code (`src/core`, `modules/*/domain`) is pure: no Nest, Drizzle, Redis, `Date.now()`,
  `new Date()`, `randomUUID()`, `Math.random()`. Time and random values are passed in.
- Library versions are pinned to the stable lines above. Before using an API, read it in the
  installed package (`node_modules/<pkg>/…d.ts`), not from memory. The drizzle 1.0 release
  candidates are not used.
- Tests are `*.spec.ts` next to the code. Tests that need Postgres or Redis are `*.db.spec.ts` and
  run only with the root script `test:db` (Vitest project `db`). `pnpm test` stays offline.
- Every guard has a test that turns red when the guard is removed. Check it by hand before each
  commit and write the mutation you tried in the commit body.
- Each commit is one topic, Conventional Commits, `pnpm check` green, hooks never skipped. A change
  to `packages/shared/src/` needs a change under `docs/api/` in the same commit (docs map).
- Local defaults: Postgres `postgres://app:app@localhost:54330/app`, Redis
  `redis://localhost:63790` (ports from `docker-compose.yml`).
- Before running tests that need the database: `pnpm db:up`, then the root script `db:migrate`.

## Review Focus

1. A customer pays for a hold whose `hold_expires_at` has passed but the expiry job has not run yet:
   the payment is refused and nothing is charged (Task 3 test, Task 5 test).
2. A payment request is repeated with the same `Idempotency-Key` after a failed charge: the stored
   failure comes back and the provider is not called again (Task 5 test).
3. A hold names a seat that belongs to another event: rejected as not found, no booking row
   (Task 4 test).
4. A seat whose earlier booking expired or was cancelled can be held again under every strategy
   (Task 4 test).
5. A sandbox event (`sandbox_user_id` set) appears neither in the public list nor at its detail URL
   (Task 6 test).

---

### Task 1: API infrastructure (config, Postgres, Redis, clock, logging, prefix, readiness)

**Files:**

- Modify: `apps/api/package.json`, `apps/api/src/config/env.ts`,
  `apps/api/src/config/env.spec.ts`, `apps/api/src/config/config.module.ts`,
  `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/modules/health/*`,
  `packages/shared/src/health.ts`, `apps/web/Caddyfile`, `apps/web/proxy.conf.json`,
  `.env.example`, `CONTRIBUTING.md`
- Create: `apps/api/src/core/clock.ts`, `apps/api/src/infrastructure/clock/system-clock.ts`,
  `apps/api/src/infrastructure/database/database.module.ts`,
  `apps/api/src/infrastructure/redis/redis.module.ts`, `apps/api/src/app.setup.ts`,
  `docs/api/rest.md`

**Interfaces:**

- Produces:
  - `EnvSchema` gains `NODE_ENV` (`development` | `test` | `production`, default `development`),
    `DATABASE_URL`, `REDIS_URL` (URLs; defaults from Global Constraints only when `NODE_ENV` is not
    `production`, otherwise required), `HOLD_TTL_SECONDS` (int, default 600),
    `PAYMENT_FAILURE_RATE` (number 0..1, default 0.1).
  - `parseEnv(raw)` keeps its signature. New `loadEnv(): Env` in `config.module.ts` is the only call
    with `process.env`; tests and scripts use it.
  - `src/core/clock.ts`: `export interface Clock { now(): Date }` and `export const CLOCK =
Symbol('CLOCK')`. `SystemClock implements Clock`.
  - `DatabaseModule` (global): token `DB`, type `export type Database = PostgresJsDatabase<typeof
schema>` (schema arrives in Task 2; until then an empty schema object). Pool size from a
    `max` constant of 20 for the API. Closes the client in `onApplicationShutdown`.
  - `RedisModule` (global): token `REDIS`, `export type Redis = ReturnType<typeof createClient>`;
    connects at startup, `quit()` on shutdown.
  - `configureApp(app: INestApplication): INestApplication` in `app.setup.ts`: global prefix `api`
    excluding the health routes (`/health/live`, `/health/ready` stay unprefixed); uses the pino
    logger. `main.ts` and route tests call it.
  - `HEALTH_STATUS` gains `DOWN`. `GET /health/ready` answers 200 `{ status: UP }` when
    `select 1` and Redis `PING` succeed, 503 `{ status: DOWN }` otherwise.
  - Logging: `LoggerModule.forRoot` with `pinoHttp.genReqId` taking `x-request-id` or a fresh UUID,
    `redact: ['req.headers.authorization', 'req.headers.cookie']`.

- [ ] **Step 1: Write the failing tests**
  - `env.spec.ts`: `production without DATABASE_URL throws and names the variable, not a value`;
    `development without DATABASE_URL uses the local default`; `PAYMENT_FAILURE_RATE above 1 is
rejected`.
  - `health.controller.spec.ts`: `GET /health/ready answers 200 UP when Postgres and Redis answer`
    and `answers 503 DOWN when Redis fails`, built with `Test.createTestingModule` and
    `overrideProvider(DB | REDIS)` with fakes (no real connection).
- [ ] **Step 2: Run `pnpm vitest run --project api`.** Expected: the new tests fail.
- [ ] **Step 3: Add the dependencies** (`drizzle-orm@^0.45`, `postgres@^4`, `redis@^6`,
      `nestjs-pino@^5`, `pino@^10`, `pino-http@^11`) with `pnpm --filter @app/api add`. Smoke-test that
      `import { createClient } from 'redis'` works under the API's ESM build before going on.
- [ ] **Step 4: Implement** the interfaces above. Caddy proxies `/api/*` to `api:3000` like
      `/health/*`; `proxy.conf.json` adds `/api`. `.env.example` lists every new variable with a
      comment. CONTRIBUTING gets the local setup lines (`pnpm db:up`, defaults, optional `.env` through
      `node --env-file-if-exists=.env` in the API `dev` and `start` scripts). `docs/api/rest.md` starts
      the REST table with the two health endpoints.
- [ ] **Step 5: Run `pnpm vitest run --project api` and `pnpm check`.** Expected: green.
- [ ] **Step 6: Mutation check:** remove the production branch of the env schema; the production
      test must fail. Restore.
- [ ] **Step 7: Commit** as `feat(api): add database, Redis, clock, logging and readiness`.

### Task 2: Schema, migration, seed and the database test setup

**Files:**

- Create: `packages/shared/src/booking.ts`, `apps/api/src/infrastructure/database/schema.ts`,
  `apps/api/drizzle.config.ts`, `apps/api/drizzle/` (generated),
  `apps/api/src/infrastructure/database/migrate.ts`,
  `apps/api/src/infrastructure/database/seed.ts`,
  `apps/api/src/infrastructure/database/schema.db.spec.ts`, `apps/api/src/testing/database.ts`,
  `docs/data-model.md`
- Modify: `packages/shared/src/index.ts`, `vitest.config.ts`, `package.json` (root scripts),
  `apps/api/package.json` (`files` gains `drizzle`), `.github/workflows/ci.yml`,
  `docs/docs-map.json`, `docs/api/rest.md`

**Interfaces:**

- Produces in `@app/shared` (`as const` dictionaries plus `z.enum` schemas and inferred types):
  `BOOKING_STRATEGY` (NAIVE, PESSIMISTIC, OPTIMISTIC, REDIS_LOCK), `BOOKING_STATUS` (HELD, PAID,
  CONFIRMED, EXPIRED, CANCELLED), `SEAT_STATUS` (AVAILABLE, HELD, SOLD), `TRANSITION_REASON` (HOLD,
  PAYMENT_SUCCEEDED, PAYMENT_FAILED, CONFIRMED, HOLD_EXPIRED, CANCELLED_BY_USER); types
  `BookingStrategy`, `BookingStatus`, `SeatStatus`, `TransitionReason`.
- `schema.ts` imports only `drizzle-orm`, `drizzle-orm/pg-core` and `@app/shared` (drizzle-kit
  loads it on its own). Tables and columns exactly as in the spec: `venues`, `venue_seats`, `events`,
  `seats` (with `version integer not null default 0`), `bookings`, `booking_transitions`. Enums as
  `pgEnum` from the dictionaries. Unique `(event_id, section, row, number)` on `seats`. Index
  `bookings(seat_id)`; partial unique index `bookings_active_seat_uidx` on `bookings(seat_id)` where
  status in (HELD, PAID, CONFIRMED) and strategy <> NAIVE. Index `bookings(status, hold_expires_at)`
  for the expiry job. Foreign keys with `on delete cascade` from seats, bookings and transitions up
  to events.
- `migrate.ts` (entry point): `loadEnv()`, run migrations from `apps/api/drizzle`, then `seed()`,
  close. `seed(db: Database): Promise<void>` is idempotent: fixed UUIDs, `onConflictDoNothing`. Seed
  data: two venues (one small hall of 4 sections × 5 rows × 10 seats, one club of 1 section × 6 rows
  × 12 seats) and four public events, one per strategy, with seats copied from the venue.
- Root scripts: `db:generate` (drizzle-kit generate in `apps/api`), `db:migrate` (build shared and
  api, run `apps/api/dist/infrastructure/database/migrate.js`), `test:db` (build shared, then
  `vitest run --project db`).
- Vitest: the `api` and `worker` projects exclude `**/*.db.spec.ts`; a new project `db` includes
  `apps/{api,worker}/src/**/*.db.spec.ts` with the same setup file.
- `src/testing/database.ts`: `openTestDatabase(): { db: Database; close(): Promise<void> }` (via
  `loadEnv()`, pool `max` 60 for the concurrency test) and
  `createTestEvent(db, input: { strategy: BookingStrategy; seats: number; sandboxUserId?: string }):
Promise<{ eventId: string; seatIds: string[] }>` with random IDs, so test files never collide and
  need no truncation.
- CI job `test-db`: Postgres and Redis as services with the image tags from `docker-compose.yml`,
  mapped to ports 54330 and 63790; steps `pnpm db:migrate`, `pnpm test:db`, then a drift check:
  `pnpm db:generate` followed by `git status --porcelain apps/api/drizzle` must be empty.
- Docs map: `apps/api/src/infrastructure/database/` → `docs/data-model.md` (ERD in Mermaid, the
  state machine diagram, why `strategy` sits on the booking).

- [ ] **Step 1: Write the failing test** `schema.db.spec.ts`:
  - `two active bookings of a PESSIMISTIC event on one seat violate bookings_active_seat_uidx`
    (error code `23505`, constraint name asserted);
  - `two active NAIVE bookings on one seat are accepted`;
  - `an EXPIRED and a HELD booking on one seat are accepted`;
  - `seed() twice leaves the same row counts`.
- [ ] **Step 2: Run `pnpm test:db`.** Expected: fails (no schema).
- [ ] **Step 3: Implement** schema, config, `pnpm db:generate` (commit the generated SQL unedited),
      `migrate.ts`, `seed.ts`, testing helpers, scripts, CI job, docs.
- [ ] **Step 4: Run `pnpm db:up && pnpm db:migrate && pnpm test:db && pnpm check`.** Expected:
      green. Run `pnpm db:generate` again: no new file.
- [ ] **Step 5: Mutation check:** drop the `strategy <> NAIVE` part of the index in the schema and
      regenerate in a scratch copy: the NAIVE test must fail. Discard the scratch migration.
- [ ] **Step 6: Commit** as `feat(api): add booking schema, migration and seed`.

### Task 3: Booking state machine (domain)

**Files:**

- Create: `apps/api/src/modules/bookings/domain/booking-state-machine.ts`,
  `apps/api/src/modules/bookings/domain/booking-state-machine.spec.ts`,
  `apps/api/src/modules/bookings/domain/seat-status.ts`,
  `apps/api/src/modules/bookings/domain/seat-status.spec.ts`

**Interfaces:**

- Consumes: dictionaries and types from Task 2.
- Produces:

```ts
export interface BookingState {
  id: string;
  status: BookingStatus;
  holdExpiresAt: Date;
}
export interface TransitionRecord {
  bookingId: string;
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  reason: TransitionReason;
  actorId: string;
  at: Date;
}
export interface TransitionResult {
  booking: BookingState;
  record: TransitionRecord;
}
export function startHold(input: {
  bookingId: string;
  actorId: string;
  now: Date;
  ttlSeconds: number;
}): TransitionResult;
export function transition(
  booking: BookingState,
  reason: TransitionReason,
  actorId: string,
  now: Date
): TransitionResult;
export class BookingTransitionError extends Error {} // carries from, reason
export function seatStatusOf(activeBookingStatus: BookingStatus | null): SeatStatus;
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[]; // HELD, PAID, CONFIRMED
```

Rules: `startHold` gives HELD with `holdExpiresAt = now + ttl`, record from `null` with reason
HOLD. `transition`: PAYMENT_SUCCEEDED HELD→PAID only while `now < holdExpiresAt`; CONFIRMED
PAID→CONFIRMED; PAYMENT_FAILED HELD→CANCELLED; HOLD_EXPIRED HELD→EXPIRED only when
`now >= holdExpiresAt`; CANCELLED_BY_USER from HELD or CONFIRMED to CANCELLED; HOLD is never a
transition. Everything else throws `BookingTransitionError`. `seatStatusOf`: null → AVAILABLE,
HELD → HELD, PAID or CONFIRMED → SOLD, EXPIRED or CANCELLED → AVAILABLE.

- [ ] **Step 1: Write the failing tests:** one `it.each` row per allowed transition (asserting
      the new status and the full record) and one per forbidden pair (all statuses × all reasons not in
      the allowed table), plus `PAYMENT_SUCCEEDED at holdExpiresAt is refused` and `HOLD_EXPIRED one
millisecond before holdExpiresAt is refused`; a table test for `seatStatusOf`.
- [ ] **Step 2: Run `pnpm vitest run --project api booking-state-machine`.** Expected: fails.
- [ ] **Step 3: Implement** with a transition table (`Record<TransitionReason, { from:
readonly BookingStatus[]; to: BookingStatus }>` minus HOLD) plus the two time guards.
- [ ] **Step 4: Run the tests and `pnpm check`.** Expected: green.
- [ ] **Step 5: Mutation check:** flip each time guard (`<` to `<=`) in turn; a test must die each
      time.
- [ ] **Step 6: Commit** as `feat(api): add booking state machine`.

### Task 4: Hold under four strategies, double-booking count, concurrency test

**Files:**

- Create: `apps/api/src/modules/bookings/domain/seat-reservation.ts` (port and outcome dictionary),
  `apps/api/src/modules/bookings/adapters/insert-hold.ts`,
  `apps/api/src/modules/bookings/adapters/{naive,pessimistic,optimistic,redis-lock}.reservation.ts`,
  `apps/api/src/modules/bookings/bookings.service.ts`,
  `apps/api/src/modules/bookings/bookings.module.ts`, `apps/api/src/modules/bookings/index.ts`,
  `apps/api/src/modules/bookings/bookings.hold.db.spec.ts`,
  `apps/api/src/modules/bookings/bookings.concurrency.db.spec.ts`,
  `docs/adr/0002-booking-strategies-and-database-constraint.md`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**

- Consumes: `Database`/`DB`, `Redis`/`REDIS`, `Clock`/`CLOCK`, `Env`/`APP_CONFIG` (Task 1),
  schema (Task 2), `startHold`, `ACTIVE_BOOKING_STATUSES` (Task 3).
- Produces:

```ts
export const HOLD_OUTCOME = {
  HELD: 'HELD',
  SEAT_TAKEN: 'SEAT_TAKEN',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
} as const;
export interface HoldInput {
  eventId: string;
  seatId: string;
  userId: string;
}
export type HoldResult =
  | { outcome: typeof HOLD_OUTCOME.HELD; bookingId: string; holdExpiresAt: Date }
  | { outcome: typeof HOLD_OUTCOME.SEAT_TAKEN | typeof HOLD_OUTCOME.CONSTRAINT_VIOLATION };
export interface SeatReservation {
  hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult>;
}
// BookingsService
hold(input: HoldInput): Promise<HoldResult>; // throws NotFoundException when the seat is not in the event
countDoubleBookings(eventId: string): Promise<number>; // Σ (active bookings per seat − 1), in SQL
```

- `insertHold(tx, input, now, ttlSeconds)` writes the booking (`strategy` copied from the event)
  and its transition record from `startHold`; it maps Postgres `23505` on
  `bookings_active_seat_uidx` to CONSTRAINT_VIOLATION and rethrows everything else.
- Adapters: naive reads active bookings without a lock and inserts if none; pessimistic locks the
  seat row with `FOR UPDATE` in a transaction; optimistic reads `seats.version`, inserts and bumps
  the version with `WHERE version = $read`, retrying the whole attempt up to 3 times on zero rows;
  redis-lock takes `lock:seat:<seatId>` with a random token, `NX` and `PX` 5000, does the check and
  insert, and releases with a compare-and-delete Lua script in `finally`. A lock that is not
  acquired is SEAT_TAKEN.
- `BookingsModule` exports `BookingsService`; `index.ts` exports `BookingsModule`,
  `BookingsService`, `HOLD_OUTCOME` and the types.
- ADR 0002: four strategies, the partial unique index as defense in depth, NAIVE excluded from it
  only for comparison, rejected: a status column on seats, a database-wide exclusion constraint
  without the NAIVE exception.

- [ ] **Step 1: Write the failing tests.**
  - `bookings.hold.db.spec.ts`, `describe.each` over all strategies: `holds a free seat`;
    `reports SEAT_TAKEN for a seat with an active hold`; `holds a seat again after its booking
expired` and `after it was cancelled`; `rejects a seat of another event with NotFound and writes no
row`.
  - `bookings.concurrency.db.spec.ts`, `describe.each` over all strategies: 50 parallel `hold()`
    calls by different users on one seat. NAIVE: `countDoubleBookings > 0`. Every other strategy:
    `countDoubleBookings === 0`, exactly one HELD outcome and zero CONSTRAINT_VIOLATION outcomes.
- [ ] **Step 2: Run `pnpm test:db`.** Expected: fails.
- [ ] **Step 3: Implement** the port, `insertHold`, the four adapters, the service (strategy
      read from the event row, adapter picked from a `Record<BookingStrategy, SeatReservation>`), the
      module and the ADR.
- [ ] **Step 4: Run `pnpm test:db` five times in a row.** Expected: green every time. If the NAIVE
      race is flaky, stop and report the failure rate instead of adding sleeps.
- [ ] **Step 5: Mutation check:** remove `FOR UPDATE` in pessimistic, the version condition in
      optimistic and the `NX` in redis-lock, one at a time; the concurrency test of that strategy must
      fail (either doubles or a CONSTRAINT_VIOLATION).
- [ ] **Step 6: Commit** as `feat(api): hold seats under four booking strategies`.

### Task 5: Payment, cancel, hold expiry in the worker

**Files:**

- Create: `apps/api/src/modules/bookings/domain/payment-provider.ts` (port),
  `apps/api/src/modules/bookings/adapters/fake-payment.provider.ts`,
  `apps/api/src/modules/bookings/bookings.payment.db.spec.ts`,
  `apps/api/src/modules/bookings/bookings.expiry.db.spec.ts`,
  `apps/worker/src/hold-expiry.job.ts`, `apps/worker/src/hold-expiry.job.spec.ts`
- Modify: `apps/api/src/modules/bookings/bookings.service.ts`, `apps/api/package.json` (`exports`
  and declarations), `apps/api/tsconfig.build.json`, `apps/worker/package.json`,
  `apps/worker/src/worker.module.ts`, `apps/worker/src/main.ts`, `Dockerfile`,
  `docker-compose.yml`, `.github/workflows/ci.yml`, `package.json` (root `test` builds the API
  before Vitest), `CONTRIBUTING.md`

**Interfaces:**

- Consumes: Tasks 1 to 4.
- Produces:

```ts
export interface PaymentProvider {
  charge(input: {
    bookingId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ succeeded: boolean }>;
}
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
// FakePaymentProvider(failureRate: number, random: () => number)
// BookingsService
pay(input: { bookingId: string; userId: string; idempotencyKey: string }): Promise<BookingView>;
cancel(input: { bookingId: string; userId: string }): Promise<BookingView>;
expireHolds(now: Date): Promise<number>;
// BookingView = { id: string; status: BookingStatus; holdExpiresAt: Date }
```

- `pay`: in one transaction, lock the booking row. Unknown booking: NotFoundException; a booking of
  another user: ForbiddenException. Same key as stored: return the current view without charging.
  Another key while not HELD, or the hold has passed (state machine refuses): ConflictException.
  Otherwise store the key, charge, and on success apply PAYMENT_SUCCEEDED then CONFIRMED, on failure
  PAYMENT_FAILED; store every transition. `// shortcut: the fake charge runs inside the database
transaction; a real provider call moves out of it with the outbox in phase 2.`
- `cancel`: same ownership rules; CANCELLED_BY_USER through the state machine; a refused transition
  is a ConflictException.
- `expireHolds(now)`: selects HELD bookings with `hold_expires_at <= now` using `FOR UPDATE SKIP
LOCKED` in batches of 500, applies HOLD_EXPIRED with actor `system`, returns the count.
- `@app/api` package `exports`: `./bookings`, `./config`, `./database`, `./redis`, `./clock`, each
  `{ types: ./dist/….d.ts, default: ./dist/….js }`; `tsconfig.build.json` emits declarations. The API
  `typecheck` script builds first (like `packages/shared`), so `pnpm -r typecheck` finds the
  declarations for the worker.
- Worker: `WorkerModule` imports `LoggerModule.forRoot()`, `ScheduleModule.forRoot()`, the config,
  database, Redis modules and `BookingsModule`. `HoldExpiryJob.run()` with `@Interval(2000)` calls
  `expireHolds(clock.now())` and logs the count when it is above zero.
- Docker: build stage also deploys `@app/worker`; target `worker`. Compose: one-shot service
  `migrate` (API image, `node dist/infrastructure/database/migrate.js`), `api` and `worker` depend on
  it with `service_completed_successfully`, both get `DATABASE_URL` and `REDIS_URL` pointing at the
  Compose services. The CI `stack` job also checks `GET /health/ready` through Caddy.

- [ ] **Step 1: Write the failing tests.**
  - `bookings.payment.db.spec.ts` with a fake provider that records calls: `pays a held booking and
confirms it with HELD→PAID→CONFIRMED transitions`; `a failed charge cancels with PAYMENT_FAILED`;
    `the same key after a failed charge returns CANCELLED and does not charge again`; `the same key
after success returns CONFIRMED without a second charge`; `another key on a confirmed booking is a
conflict`; `a hold past its expiry is a conflict and is not charged`; `another user's booking is
forbidden`; `cancel of a confirmed booking frees the seat` (a new hold then succeeds).
  - `bookings.expiry.db.spec.ts`: `expires only holds whose time has passed and stores HOLD_EXPIRED`;
    `two parallel expireHolds runs expire each hold once` (transition count).
  - `hold-expiry.job.spec.ts`: the job passes the injected clock's time to `expireHolds` (fake
    service and clock through the Nest testing module).
  - `fake-payment.provider.spec.ts`: `random below the failure rate fails, at or above succeeds`.
- [ ] **Step 2: Run `pnpm test:db` and `pnpm test`.** Expected: the new tests fail.
- [ ] **Step 3: Implement** service methods, provider, package exports, worker module and job,
      Docker and Compose changes, CI step.
- [ ] **Step 4: Run `pnpm test`, `pnpm test:db`, `pnpm check`, then `docker compose up -d --build
--wait`** and `curl -fsS localhost:8080/health/ready`. Expected: green, the worker container
      running, readiness UP. `docker compose down` afterwards.
- [ ] **Step 5: Mutation check:** remove the idempotency-key comparison; remove `SKIP LOCKED`; flip
      the ownership check. A test must die each time.
- [ ] **Step 6: Commit** in two commits: `feat(api): pay and cancel bookings with idempotency
keys` and `feat(worker): expire holds on a schedule`.

### Task 6: Event list and seat map (contract, API, web)

**Files:**

- Create: `packages/shared/src/events.ts`, `apps/api/src/modules/events/*` (controller, service,
  module, `index.ts`, `events.controller.db.spec.ts`), `apps/api/src/infrastructure/http/zod.pipe.ts`,
  `apps/web/src/app/events/event-list.ts|html|spec.ts`,
  `apps/web/src/app/events/seat-map.ts|html|spec.ts`, `apps/web/src/app/events/events.service.ts`,
  `apps/web/src/app/app.routes.ts`, `DESIGN.md`
- Modify: `packages/shared/src/index.ts`, `apps/api/src/app.module.ts`, `apps/web/src/app/app.*`,
  `apps/web/src/styles.css`, `docs/api/rest.md`, `README.md`

**Interfaces:**

- Consumes: `seatStatusOf`, `ACTIVE_BOOKING_STATUSES` through the bookings module's `index.ts`;
  `configureApp` for the route test.
- Produces in `@app/shared`: `EventSummarySchema` `{ id: uuid, name, startsAt: iso datetime string,
venueName, strategy }`, `EventListResponseSchema` (array), `SeatSchema` `{ id, section, row,
number, priceCents, status: SeatStatus }`, `EventDetailSchema` (summary plus `seats`).
- `GET /api/events`: public events only (`sandbox_user_id is null`), ordered by `starts_at`.
  `GET /api/events/:id`: 400 for a non-UUID id (`ZodPipe`), 404 for an unknown or sandbox event,
  seats with status from one SQL query (left join on the active booking per seat, mapped with
  `seatStatusOf`).
- `ZodPipe(schema)` implements `PipeTransform`, throws `BadRequestException` with the issue paths.
- Web: routes `/` (event list) and `/events/:id` (seat map). `EventsService` parses with the shared
  schemas. The list handles loading, empty, error with retry; the seat map handles loading, error
  with retry and not found, renders seats grouped by section and row as buttons that are disabled
  for now, with an `aria-label` like `Section A, row 3, seat 7, held`, and status shown by shape or
  pattern plus color. `DESIGN.md` defines the semantic tokens (surface, text, accent, seat states) as
  Tailwind theme variables in `styles.css`; components use only those tokens. The footer notice
  stays.

- [ ] **Step 1: Write the failing tests.**
  - `events.controller.db.spec.ts`: `lists public events and hides sandbox events`; `detail shows a
held seat as HELD and a confirmed one as SOLD`; `detail of a sandbox event is 404`; `a non-UUID id is
400`.
  - Web specs with `HttpTestingController` and `verify()`: list shows the empty message, the error
    with a working retry, and the event names; seat map renders seat buttons with the status in the
    accessible name and shows not found on 404.
- [ ] **Step 2: Run `pnpm test:db` and `pnpm test`.** Expected: the new tests fail.
- [ ] **Step 3: Implement** contract, API module, web, tokens, `DESIGN.md`, `docs/api/rest.md`
      rows, README sections for requirements, entities (link to `docs/data-model.md`) and API (link to
      `docs/api/rest.md`).
- [ ] **Step 4: Run `pnpm test`, `pnpm test:db`, `pnpm check`.** Expected: green.
- [ ] **Step 5: Browser check** with `pnpm db:up`, `pnpm db:migrate`, `pnpm dev`: event list, a
      seat map, keyboard focus on seats, error state with the API stopped. Screenshot result in the
      report.
- [ ] **Step 6: Mutation check:** remove the `sandbox_user_id is null` filter; the sandbox test
      must fail.
- [ ] **Step 7: Commit** as `feat: show events and seat maps`.

### Slice end

- [ ] Final review of the slice diff (strongest model; state and concurrency packages are in it).
- [ ] Update `docs/BACKLOG.md` (state, deviations, next: slice B), push, check
      `gh run list --branch main --limit 1`, stop and report.

## Ledger

| Task                      | Duration   | Subagent tokens | Notes                                                                  |
| ------------------------- | ---------- | --------------- | ---------------------------------------------------------------------- |
| 1+2                       | 712 s      | 162.7k          | one dispatch, no own review                                            |
| 3                         | 129 s      | 93.0k           | review clean                                                           |
| 4                         | 519 s      | 300.7k          | one fix round (count filter, lock release, optimistic retries dropped) |
| 5                         | 3080 s     | 417.6k          | one fix round (key claimed before charge, parallel pay, test clocks)   |
| 6                         | 1534 s     | 134.8k          | no own review                                                          |
| Final review and fix wave | 791 s      | 293.8k          | request log, seat focus, own test database, backlog                    |
| **Sum**                   | **6765 s** | **1402.6k**     | plus 123 s / 58.1k for the library research before the plan            |
