# Phase 3, slice C: audit log, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seven state-changing actions write one row each to an append-only `audit_log` table in the transaction of the change; an admin reads the log through `GET /api/audit-log` and an admin page.

**Architecture:** A new API module `audit` owns the table access: `AuditService.record(tx, entry)` (insert into the caller's transaction, same pattern as `OutboxService.enqueue`) and `AuditService.list(query)` (keyset pagination, newest first). Services that change state call `record` inside their existing transaction; controllers hand them the request ID through a `@RequestId()` parameter decorator. The web gets one admin page with a service, like the simulator page.

**Tech Stack:** NestJS, Drizzle and drizzle-kit, Zod in `packages/shared`, Angular signals, Vitest, Playwright.

**Spec:** [Phase 3 design, slice C](../specs/2026-11-14-phase-3-observability-and-measuring-design.md#slice-c-audit-log)

## Global Constraints

- AGENTS.md applies: no `vi.mock`, no `any`, no `as unknown as`, no `export *`, no `unknown` as a parameter or return type, relative imports end in `.js`, modules import each other through `index.ts`, `// SAFETY:` on every assertion except `as const`, English docs, Conventional Commits straight on `main`, one topic per commit, hooks never skipped, `pnpm check` green before every commit.
- The migration comes from `pnpm db:generate`, never hand-edited; it only adds a table (expand step).
- **IDs only** in an audit row: actor ID, subject ID, request ID. No name, address, payload or free text.
- The action is a value of the `AUDIT_ACTION` dictionary in `packages/shared`, imported by code and tests (`pnpm audit:magic`). The same goes for the subject type (`AUDIT_SUBJECT`).
- Time of a row comes from the injected `Clock`, not from `defaultNow()`.
- **Append-only:** `audit_log` is written by `AuditService.record` only; no `update` or `delete` on the table anywhere in code. Recorded in `docs/data-model.md`.
- Audited actions are the seven of the spec, nothing else: hold expiry, a failed payment and reads are not audited. A hold made by the simulator runner is not audited (it has no request; the start of the run is).
- Cursor pagination only (no offset). Page size 1 to 100, default 50.
- Every audited change keeps its transaction: `record` runs on the `tx` of the change, so a rollback leaves no row.
- Web: UI states empty, loading, error with retry, pending; shared UI primitives and semantic tokens ([PRODUCT.md](../../../PRODUCT.md)); no `HttpClient` in a component.

## Review Focus

- A held seat refused by the partial unique index (`CONSTRAINT_VIOLATION`) or a taken seat leaves no `BOOKING_HELD` row (Task 4).
- A payment that fails, and a parallel request with the same idempotency key, write no second `BOOKING_PAID` row (Task 4).
- A strategy switch or waiting-room change on an event the caller may not touch (NotFound) writes no row (Task 3).
- A client-sent `x-request-id` is stored as is; it must not break the insert (long or odd value). The route caps the stored value at the column limit of the contract (Task 3).
- A filter by an actor with no rows answers an empty page, not an error; a malformed cursor answers 400 (Task 2).

## File structure

| Path                                                              | Responsibility                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/audit.ts`                                    | `AUDIT_ACTION`, `AUDIT_SUBJECT`, `AuditEntrySchema`, `AuditLogQuerySchema`, `AuditLogPageSchema`        |
| `apps/api/src/infrastructure/database/schema.ts`                  | table `audit_log`                                                                                       |
| `apps/api/src/modules/audit/`                                     | `audit.service.ts` (`record`, `list`), `audit.controller.ts`, `audit.module.ts`, `index.ts`, `testing/` |
| `apps/api/src/infrastructure/http/request-id.decorator.ts`        | `@RequestId()`                                                                                          |
| `apps/web/src/app/admin/audit-log-page.*`, `audit-log.service.ts` | the admin page                                                                                          |

## Interfaces (exact signatures)

```ts
// packages/shared/src/audit.ts
export const AUDIT_ACTION = {
  BOOKING_HELD: 'BOOKING_HELD',
  BOOKING_PAID: 'BOOKING_PAID',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  EVENT_CREATED: 'EVENT_CREATED',
  EVENT_STRATEGY_SWITCHED: 'EVENT_STRATEGY_SWITCHED',
  WAITING_ROOM_SETTINGS_CHANGED: 'WAITING_ROOM_SETTINGS_CHANGED',
  SIMULATION_STARTED: 'SIMULATION_STARTED',
} as const;
export const AUDIT_SUBJECT = {
  BOOKING: 'BOOKING',
  EVENT: 'EVENT',
  SIMULATION_RUN: 'SIMULATION_RUN',
} as const;
export const AUDIT_LOG_LIMITS = { PAGE_DEFAULT: 50, PAGE_MAX: 100, REQUEST_ID_MAX: 128 } as const;
// AuditEntrySchema: { id: string (decimal digits), at: ISO datetime, actorId: uuid, action, subjectType, subjectId: uuid, requestId: string }
// AuditLogQuerySchema: { action?: AuditAction, actorId?: uuid, cursor?: string (digits), limit: coerced int, default PAGE_DEFAULT }
// AuditLogPageSchema: { items: AuditEntry[], nextCursor: string | null }

// apps/api/src/modules/audit/audit.service.ts
export interface AuditRecord {
  actorId: string;
  action: AuditAction;
  subjectType: AuditSubject;
  subjectId: string;
  requestId: string;
}
class AuditService {
  record(tx: Tx, entry: AuditRecord): Promise<void>; // inserts one row, at = clock.now()
  list(query: AuditLogQuery): Promise<AuditLogPage>; // newest first, id < cursor
}

// apps/api/src/infrastructure/http/request-id.decorator.ts
export const RequestId: () => ParameterDecorator; // req.id set by pino-http (genReqId); throws if absent

// apps/api/src/modules/audit/testing/index.ts
export function auditRows(db: Database): Promise<AuditEntry[]>; // all rows, oldest first
```

`audit_log` columns: `id bigint generated always as identity` (mode `number`, primary key), `at timestamptz not null`, `actor_id uuid not null`, `action` pg enum from `AUDIT_ACTION`, `subject_type` pg enum from `AUDIT_SUBJECT`, `subject_id uuid not null`, `request_id text not null`. No foreign keys (rows outlive a deleted demo user or event). Indexes: `(actor_id, id)` and `(action, id)`. The cursor is the `id` of the last row of the previous page; the page is `id < cursor order by id desc limit n + 1`, and `nextCursor` is set when the extra row exists.

---

### Task 1: Contract, table, `record`

**Files:**

- Create: `packages/shared/src/audit.ts`, `apps/api/src/modules/audit/{audit.service.ts,audit.module.ts,index.ts,testing/index.ts,audit.service.db.spec.ts}`
- Modify: `packages/shared/src/index.ts` (named exports), `apps/api/src/infrastructure/database/schema.ts`, `docs/data-model.md`, generated `apps/api/drizzle/*`
- Interfaces: Produces the shared contract, `AuditService.record`, `auditRows`, `AuditModule` (exports `AuditService`; imports nothing but the global DB and CLOCK).

- [ ] **Step 1: Failing tests** in `audit.service.db.spec.ts`: (a) `record` inside `db.transaction` that commits leaves exactly one row with the given fields and `at` equal to the fake clock's now; (b) the same inside a transaction that throws afterwards leaves no row. Use the project's db-spec setup and a fake `Clock`.
- [ ] **Step 2:** `pnpm test:db -- audit` fails (module missing).
- [ ] **Step 3:** Write the shared schemas, the Drizzle table and enums, run `pnpm db:generate`, implement `record` (one insert on `tx`), the module and the testing helper. Add `audit_log` to the ER diagram and a paragraph in `docs/data-model.md`: append-only, written by `AuditService.record` only, no foreign keys and why, no retention (backlog).
- [ ] **Step 4:** Tests pass; `pnpm check` green. Hand mutation: insert with `this.db` instead of `tx` turns test (b) red; revert.
- [ ] **Step 5:** Commit `feat(audit): audit_log table and record in the caller's transaction`.

### Task 2: `GET /api/audit-log` (auth: review this task)

**Files:**

- Create: `apps/api/src/modules/audit/audit.controller.ts`, `audit.controller.db.spec.ts`
- Modify: `audit.service.ts` (`list`), `audit.module.ts` (controller), `apps/api/src/app.module.ts` (import `AuditModule`)
- Interfaces: Consumes Task 1. Produces `AuditService.list`, route `GET /api/audit-log` with `@Roles(ROLE.ADMIN)`; query parsed with `ZodPipe(AuditLogQuerySchema)`.

- [ ] **Step 1: Failing tests** (route spec, real app and token fixtures as in `simulations.controller.db.spec.ts`):
  - no token 401; customer 403; organizer 403; admin 200 (each role its own test).
  - 120 rows, default page has 50 newest first and a `nextCursor`; following cursors yields every row exactly once, last page has `nextCursor: null`.
  - rows inserted between two page reads do not appear twice or shift the pages (older rows only, no duplicates).
  - filter by `action` and by `actorId` return only matching rows; an unknown actor returns `{ items: [], nextCursor: null }`.
  - `cursor=abc`, `limit=0`, `limit=101` answer 400.
- [ ] **Step 2:** Fail. **Step 3:** Implement. `limit + 1` read, filter by `and(...)` on the optional conditions; the page maps `at` to ISO and `id` to string.
- [ ] **Step 4:** Pass. Hand mutations: drop `@Roles` (the wrong-role tests die); change `<` to `<=` (the once-only test dies). `pnpm check`.
- [ ] **Step 5:** Commit `feat(audit): admin route for the audit log`.

### Task 3: Request ID and the four single-write audits

**Files:**

- Create: `apps/api/src/infrastructure/http/request-id.decorator.ts` (+ spec)
- Modify: `apps/api/src/modules/events/{events.controller.ts,events.service.ts}`, `modules/waiting-room/{waiting-room.controller.ts,waiting-room.service.ts}`, `modules/organizer/{organizer.controller.ts,organizer.service.ts}`, `modules/simulations/{simulations.controller.ts,simulations.service.ts}`, their modules (import `AuditModule`), and the existing specs of these services (constructor gets `AuditService`).
- Interfaces: Consumes `AuditService.record`. Produces `@RequestId()`; each service method gains a trailing `requestId: string` parameter: `setStrategy(id, strategy, callerId, requestId)`, `setCapacity(eventId, capacity, caller, requestId)`, `createEvent(input, ownerId, requestId)`, `SimulationsService.start(input, adminId, requestId)`.

- [ ] **Step 1: Failing tests**, one per action, in the existing db specs: after the call exactly one row with the expected action, subject type and ID, actor and request ID (`EVENT_STRATEGY_SWITCHED` / `EVENT`, `WAITING_ROOM_SETTINGS_CHANGED` / `EVENT`, `EVENT_CREATED` / `EVENT`, `SIMULATION_STARTED` / `SIMULATION_RUN`). Failure paths: a strategy switch on a foreign event (NotFound) and a creation that exceeds `MAX_EVENTS_PER_OWNER` (Conflict) leave no row. The decorator spec: `x-request-id: abc` reaches the service; a request without the header gets a generated ID that is stored. A 129-character `x-request-id` is truncated by the decorator to `AUDIT_LOG_LIMITS.REQUEST_ID_MAX`.
- [ ] **Step 2:** Fail. **Step 3:** Implement. `setStrategy` and `setCapacity` wrap their update and `record` in one `db.transaction` (the re-select can stay outside); `createEvent` and `start` record before the transaction returns.
- [ ] **Step 4:** Pass. Hand mutation: move one `record` call after the transaction block, check a rollback test (the Conflict case or a forced throw) turns red. `pnpm check`.
- [ ] **Step 5:** Commit `feat(audit): record strategy, waiting-room, event and simulation changes`.

### Task 4: Booking audits (transactions: review this task)

**Files:**

- Modify: `modules/bookings/{bookings.controller.ts,bookings.service.ts,bookings.module.ts}`, `adapters/{insert-hold.ts,seat-reservations.ts,naive.reservation.ts,pessimistic.reservation.ts,optimistic.reservation.ts,redis-lock.reservation.ts}`, `domain/seat-reservation.ts` (`HoldInput` gains `requestId: string | null`), `modules/simulations/simulation-runner.ts` (passes `null`), the existing bookings and simulations specs.
- Interfaces: Consumes `AuditService.record`. `BookingsService.hold(input)` where `HoldInput.requestId` null means "not audited"; `pay(input)` and `cancel(input)` gain `requestId: string`. `insertHold(tx, input, now, ttlSeconds, audit: AuditService)` records `BOOKING_HELD` inside its savepoint, after the booking insert, so a refused insert leaves no row. The four strategy adapters and `SeatReservations` receive the `AuditService` through their constructors (domain files import no Drizzle).

- [ ] **Step 1: Failing tests** (existing db specs): hold placed writes one `BOOKING_HELD` row (subject = the booking); seat taken and `CONSTRAINT_VIOLATION` (naive strategy, two parallel holds of one seat) write rows only for the placed holds, never for a refused one; a hold with `requestId: null` writes none; successful payment writes one `BOOKING_PAID` row in the transaction that stores CONFIRMED; a failed payment (`PAYMENT_FAILED`) writes none; two parallel payments with one idempotency key write one row; cancel writes one `BOOKING_CANCELLED` row; a cancel refused with Conflict writes none. Concurrency spec (existing, per strategy): rows of `BOOKING_HELD` equal the number of bookings.
- [ ] **Step 2:** Fail. **Step 3:** Implement. In `chargeAndApply` the `BOOKING_PAID` record sits next to the outbox enqueue (success branch only); `cancel` records in its transaction.
- [ ] **Step 4:** Pass (`pnpm test:db` and `pnpm test:db:pooled` for the bookings specs). Hand mutations: move the `BOOKING_PAID` insert after the transaction (the rollback/failed-payment cases must catch it or add a test that forces a throw after the apply); drop the record inside the savepoint (the constraint test dies). `pnpm check`.
- [ ] **Step 5:** Commit `feat(audit): record holds, payments and cancellations`.

### Task 5: Admin page

**Files:**

- Create: `apps/web/src/app/admin/{audit-log.service.ts,audit-log.service.spec.ts,audit-log-page.ts,audit-log-page.html,audit-log-page.spec.ts}`
- Modify: `apps/web/src/app/app.routes.ts` (`admin/audit-log`, `roleGuard(ROLE.ADMIN)`), `app.html` (link "Audit log" next to "Simulator", admin only like that link)
- Interfaces: `AuditLogService.page(query: { action?: AuditAction; actorId?: string; cursor?: string }): Observable<AuditLogPage>` parsing the response with `AuditLogPageSchema`.

- [ ] **Step 1: Failing tests** (`HttpTestingController.verify()`): service sends the filters as query params and rejects a malformed body; page shows loading, then a table (time, action, actor ID, subject type and ID, request ID); empty ("No entries"), error with a Retry button that reloads, "Load more" appends the next page and is disabled while loading (pending, no double submit); changing the action filter reloads from the first page.
- [ ] **Step 2:** Fail. **Step 3:** Implement with signals; shared UI primitives and tokens.
- [ ] **Step 4:** `pnpm test`, `pnpm check`; look at the page in a browser (chrome-devtools or Playwright) on a running stack: all four states.
- [ ] **Step 5:** Commit `feat(web): audit log page`.

### Task 6: End-to-end, docs, backlog

**Files:**

- Create: `apps/web/e2e/audit-log.e2e.ts`
- Modify: `docs/BACKLOG.md` (slice C state, deviations, open points), `docs/api/*` (via `pnpm docs:generate`), `README.md` only if it lists features, `docs/observability.md` untouched.

- [ ] **Step 1:** E2E: an admin switches the strategy of a sandbox event (or starts a run), opens "Audit log" and sees the action row; a customer has no link and `/admin/audit-log` redirects (as the roles spec does for the simulator).
- [ ] **Step 2:** `pnpm e2e` green.
- [ ] **Step 3:** `pnpm docs:generate`; BACKLOG: slice C complete section; deviations (service instead of a separate port interface, as with the outbox; holds of the simulator not audited; cursor is the identity ID, a row that commits after a page read with a lower ID can be missed by a reader already past it); open points (no retention of audit rows, no DB-level append-only guard because migrations are generated; a trigger would need a hand-written migration); update the "Next" section (only slice D remains).
- [ ] **Step 4:** Whole-slice review by `pruefer` (diff since the commit before Task 1). Fix findings.
- [ ] **Step 5:** `gh run list --branch main --limit 1` after the push; fix a red run. Commit `docs: slice C state of phase 3`.

## Self-review

Spec coverage: table and append-only (T1), port/adapter in the surrounding transaction (T1, T3, T4; port is a service as with the outbox), seven actions (T3: four, T4: three), route admin-only with filters and keyset (T2), page with four states (T5), docs and backlog (T1, T6). Guard "insert outside the transaction turns the rollback test red": T1 mutation, T3 and T4 mutations. Out of scope: retention, metrics for audit writes, filtering by time or subject.
