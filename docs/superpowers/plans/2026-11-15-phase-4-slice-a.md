# Phase 4, slice A: security hardening, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Row-level security as a second ownership layer on customer-owned booking queries, hardened containers with a spec that enforces it, and a threat model that links the controls.

**Architecture:** A non-superuser runtime role runs API and worker; migrations run as the owner. Policies on `bookings` and `booking_transitions` restrict rows only while a transaction has set `app.scope = 'user'` and `app.user_id`; a small helper sets and resets both around customer-owned statements. Hardening is declared in `docker-compose.yml` and checked by a spec. The threat model is a document whose links a spec verifies.

**Tech Stack:** PostgreSQL 18, drizzle-orm and drizzle-kit (custom migration), postgres.js, Vitest (`db` project), Docker Compose.

**Spec:** [Phase 4 design, slice A](../specs/2026-11-15-phase-4-hardening-design.md#slice-a)

## Deviation from the spec (decided here, recorded in ADR 0009)

The spec says a request that sets no scope sees no rows. That would force every one of the ~20
transaction sites (worker, expiry, simulator, organizer, outbox) to set a scope, and
`lockOwnBooking` must keep answering 403 for a foreign booking (AGENTS.md, auth tests), which a
user-scoped read would turn into 404. Instead: **the policy restricts only while
`app.scope = 'user'`**; customer-owned statements opt in. Inside the user scope a missing
`app.user_id` still sees nothing (fail closed). Consequence: a customer path that forgets the
helper is not protected; the specs of Task 3 cover the paths that use it. Update the spec's
A1 section in the same commit as the ADR.

## Global Constraints

- AGENTS.md applies: no `vi.mock`, no `any`, no `as unknown as`, no `export *`, no `unknown` as a parameter or return type, relative imports end in `.js`, `// SAFETY:` on every assertion except `as const`, English docs, Conventional Commits straight on `main`, one topic per commit, hooks never skipped, `pnpm check` green before every commit, no `.env*` read or staged.
- The RLS migration comes from `drizzle-kit generate --custom` (`pnpm --filter @app/api exec drizzle-kit generate --custom --name rls_bookings`), never edited after generation. It is backward compatible: policies that only restrict inside the user scope change nothing for existing paths.
- Scope values and setting names are constants in a dictionary (`RLS_SCOPE`, `RLS_SETTING`), imported by code and tests (`pnpm audit:magic`).
- `set_config(..., true)` (transaction-local) only; PgBouncer runs in transaction mode ([ADR 0005](../../adr/0005-pgbouncer-transaction-mode.md)).
- `MIGRATION_DATABASE_URL` is read through the config module like every other variable and listed in `.env.example`.
- Images in Compose carry tag and digest; resource numbers come from `docker stats` during `pnpm load`, not from guessing (AGENTS.md invariant 9: verify digests against the registry).
- Docs change in the same commit as the code; docs-map entries for new paths (`docs/security/`).
- Before long builds: `df -h`. Per task: note duration and subagent tokens in the ledger; sum line at the end.

## Review Focus

- A foreign booking in `pay`/`cancel` still answers 403, not 404 (Task 3).
- The user scope does not leak to the next transaction on a pooled connection (Task 2).
- The migration job fails clearly (no silent fallback to the runtime role) when `MIGRATION_DATABASE_URL` is missing in production (Task 1).
- A Compose service added later without limits or digest fails the spec (Task 4).
- A link in the threat model to a moved file fails the spec (Task 5).

---

### Task 1: Runtime role and two connection URLs

**Files:**

- Modify: `docker/postgres/init.sql`, `docker-compose.yml`, `apps/api/src/config/env.ts`, `apps/api/src/infrastructure/database/migrate.ts`, `apps/api/src/testing/db-global-setup.ts`, `apps/api/src/testing/test-database-url.ts`, `.env.example`, `.github/workflows/ci.yml`, `CONTRIBUTING.md`
- Test: `apps/api/src/config/env.spec.ts` (extend), `apps/api/src/infrastructure/database/runtime-role.db.spec.ts` (create)

**Interfaces:**

- Produces: role `app_runtime` (LOGIN, NOSUPERUSER, NOBYPASSRLS, not owner), env `MIGRATION_DATABASE_URL` (owner, used by `migrate.ts` and the db global setup only), `DATABASE_URL` now the runtime login. Test helper keeps exporting the runtime URL; a second export returns the owner URL.

- [ ] **Step 1: Failing specs.** Env spec: `MIGRATION_DATABASE_URL` is required in production and defaults to `DATABASE_URL`'s owner twin in development. DB spec `runtime-role.db.spec.ts`: connected as the runtime role, `select rolsuper, rolbypassrls from pg_roles where rolname = current_user` returns false/false and the role owns none of the tables. Guard: pointing the runtime URL at `app` turns the second spec red.
- [ ] **Step 2: Run both, expect failure.**
- [ ] **Step 3: Implement.** `init.sql` creates the role with a development password; the db global setup creates it too when absent (CI service has no init script) and grants `CONNECT`. `migrate.ts` uses `MIGRATION_DATABASE_URL`. Compose: `migrate` gets the owner URL, API and worker the runtime URL (PgBouncer userlist gets the new role; verify the PgBouncer image's auth mechanism in its docs first).
- [ ] **Step 4: Run `pnpm test`, `pnpm test:db`, `pnpm test:db:pooled`.** Existing db specs may fail on missing privileges: that is expected until Task 2 grants them; commit Tasks 1 and 2 only together if so.
- [ ] **Step 5: Commit** `feat(db): separate runtime role from the migration owner`.

### Task 2: Custom migration with grants and policies

**Files:**

- Create: `apps/api/drizzle/<generated>_rls_bookings.sql` (via `generate --custom`), `apps/api/src/infrastructure/database/rls.db.spec.ts`
- Modify: `packages/shared` only if the scope dictionary is shared (it is not: keep `RLS_SCOPE` and `RLS_SETTING` in `apps/api/src/infrastructure/database/rls.ts`)

**Interfaces:**

- Produces in `rls.ts`:
  - `RLS_SCOPE = { USER: 'user', SYSTEM: 'system' } as const`
  - `RLS_SETTING = { SCOPE: 'app.scope', USER_ID: 'app.user_id' } as const`
  - `withOwner<T>(tx: Tx, userId: string, run: () => Promise<T>): Promise<T>`: sets scope `user` and the user ID transaction-locally, awaits `run`, and in `finally` sets the scope back to `system`.

Security-critical SQL (the only SQL the plan fixes; applies to `bookings`, and to `booking_transitions` through its booking):

```sql
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY bookings_owner ON bookings
  USING (current_setting('app.scope', true) IS DISTINCT FROM 'user'
         OR user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (current_setting('app.scope', true) IS DISTINCT FROM 'user'
         OR user_id = nullif(current_setting('app.user_id', true), '')::uuid);
-- booking_transitions: same predicate over `exists (select 1 from bookings b where b.id = booking_id ...)`
-- plus GRANT SELECT, INSERT, UPDATE, DELETE on all tables and USAGE on sequences to app_runtime.
```

`FORCE` matters only if the runtime role were the owner; keep it so a later role change cannot silently disable RLS.

- [ ] **Step 1: Write `rls.db.spec.ts` (fails: no policies).** Cases, each with the guard that turns it red:
  1. In the user scope of A, selecting B's booking returns nothing (drop the policy).
  2. In the user scope of A, update and delete of B's booking affect 0 rows (drop `USING`).
  3. In the user scope of A, an insert with `user_id` of B is refused (drop `WITH CHECK`).
  4. User scope with no `app.user_id` sees nothing (replace `nullif(...)::uuid` by a permissive default).
  5. Without a scope (or scope `system`) all rows are visible: the worker and cross-user paths are unchanged (make the first predicate `true`-less).
  6. After `withOwner` returns or throws, the next statement in the same transaction and a new transaction on the same pooled connection see all rows (switch `set_config` to session-local `false`). Run it against the pooled URL too.
  7. `booking_transitions` of B's booking are invisible in A's scope.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Generate the custom migration, write the SQL above, implement `withOwner`.** Run `pnpm db:generate` once more: no further file may appear (CI drift check).
- [ ] **Step 4: Run `pnpm test:db` and `pnpm test:db:pooled`: all green, including the concurrency specs.**
- [ ] **Step 5: Commit** `feat(db): row-level security on bookings for the user scope`.

### Task 3: Apply the user scope on customer-owned paths

**Files:**

- Modify: `apps/api/src/modules/bookings/adapters/load-own-bookings.ts`, `adapters/lock-own-booking.ts` callers in `bookings.service.ts` (pay, cancel writes), `adapters/booking-transitions.ts` call sites in pay and cancel, `apps/api/src/modules/tickets/tickets.service.ts` (download read)
- Test: the existing `*.db.spec.ts` of bookings and tickets (extend)

**Interfaces:**

- Consumes: `withOwner` from Task 2.
- Rules: `lockOwnBooking` keeps its single read under the system scope, so a foreign booking answers 403 as before. The transition writes of `pay` and `cancel` (the `update(bookings)` and the `booking_transitions` insert made for a customer request) run inside `withOwner(tx, input.userId, …)`. `loadOwnBookings` runs its select inside `withOwner` (it opens a transaction when it receives the plain `Database`). The ticket download read does the same. Expiry, simulator and worker paths are not touched.

- [ ] **Step 1: Failing specs (extend existing db specs).**
  1. `loadOwnBookings` with its `user_id` filter removed returns nothing foreign (mutation by hand: delete the filter, the spec must stay green only because of RLS; then restore).
  2. `pay` and `cancel` of a foreign booking answer 403 and change no row (guard: remove `withOwner` and the explicit owner check together turns it red; remove only `withOwner`: case 3 below).
  3. A forced write path: call the transition update for B's booking inside `withOwner(tx, A, …)`: 0 rows (guard: remove `withOwner` at the pay/cancel call site).
  4. Ticket download of a foreign booking: 404 as today.
- [ ] **Step 2: Run, expect failure where the helper is missing.**
- [ ] **Step 3: Wire the helper at the sites above.** Keep each change to the call site; do not restructure services (`bookings.service.ts` is at the 300-line limit: move the wrapped statements into the adapters, not into the service).
- [ ] **Step 4: Run `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm e2e`.** All green.
- [ ] **Step 5: Hand mutation per guard:** remove each `withOwner` call and the policy; each removal kills at least one spec. Note the results in the commit message.
- [ ] **Step 6: Commit** `feat(bookings): enforce ownership in the database for customer paths`.

### Task 4: ADR 0009 and data-model docs

**Files:**

- Create: `docs/adr/0009-row-level-security.md`
- Modify: `docs/data-model.md`, `docs/superpowers/specs/2026-11-15-phase-4-hardening-design.md` (A1 deviation), `docs/BACKLOG.md` (state, open point: paths without the helper are unprotected; system scope is a session variable), `README.md`/`CONTRIBUTING.md` setup lines for the two URLs.

- [ ] **Step 1: Write the ADR** (MADR, template `0000-template.md`): context, decision (opt-in user scope, runtime role), rejected alternatives (fail-closed everywhere: ~20 sites and 403 to 404 change; `pgPolicy` in the schema: drizzle-kit support for session settings is limited; `SECURITY DEFINER` views for aggregates: more objects to maintain; a second `BYPASSRLS` role with two pools: cannot mix scopes inside the hold transaction), consequences (guards a forgotten filter, not SQL injection).
- [ ] **Step 2: Update data model, spec and backlog.** `pnpm docs:generate`, `pnpm check`.
- [ ] **Step 3: Commit** `docs(security): ADR 0009 and data model for row-level security`.

### Task 5: Container hardening

**Files:**

- Modify: `docker-compose.yml` (and `docker-compose.e2e.yml`, `docker-compose.loadtest.yml` only where they override), `Dockerfile` if a stage needs a writable path
- Create: `scripts/audit/compose-hardening.spec.ts` or the location where the existing script specs live (check `scripts/` and `vitest.config.ts` projects first)

**Interfaces:**

- Rule set the spec enforces for every service of `docker-compose.yml`: image has `@sha256:` digest (built services exempt); `mem_limit` and `cpus` present; `cap_drop` contains `ALL`; `security_opt` contains `no-new-privileges:true`; `read_only: true` or an adjacent `# hardening-exception: <reason>` comment on that service. Parse with the YAML parser already in the lockfile (check `pnpm why yaml`; add none otherwise without asking, justify in the commit).

- [ ] **Step 1: Failing spec** over the current file. Guards: delete a `mem_limit`, a digest, a `cap_drop` in a copy of the file: the spec fails for it (test the checker on fixture strings, not only on the real file).
- [ ] **Step 2: Measure.** Start the stack, run `pnpm load`, read `docker stats --no-stream`; set each limit to about 2x the observed peak, minimum 64 MB, and list the numbers in the commit message for the phase 5 ADR.
- [ ] **Step 3: Resolve digests** (`docker buildx imagetools inspect <tag>`) and add them; add the hardening keys; per service, start it and fix what breaks (tmpfs for `/tmp`, `/run`; Postgres, Keycloak and Grafana stack keep the writable paths they need and get an exception comment with the reason).
- [ ] **Step 4: `docker compose up --build` healthy, `pnpm e2e` green, CI `stack` job green.** Check `df -h` first.
- [ ] **Step 5: Commit** `feat(docker): pin images by digest, add limits and drop capabilities`. Remove the "pin by digest" note from `docs/BACKLOG.md` Next in the same commit.

### Task 6: Threat model

**Files:**

- Create: `docs/security/threat-model.md`, `scripts/audit/threat-model-links.spec.ts` (or extend `audit-docs.mjs`; prefer extending the existing audit if it already checks links)
- Modify: `docs/docs-map.json` (security-relevant paths map to the threat model), `README.md` documentation table, `docs/BACKLOG.md`

**Interfaces:** Document structure: per boundary (browser to Caddy, Caddy to API, API to Postgres, API and worker to Redis, worker to SQS and S3, API to Keycloak) a table with columns Threat (STRIDE letter), Control, Evidence (relative link to a spec, ADR or doc). Final sections: ASVS mapping (V2, V3, V4, V5, V8, V13, V14) and residual risks copied by link from the backlog.

- [ ] **Step 1: Failing check:** every relative link in `docs/security/threat-model.md` resolves to an existing file (and anchor where given). Guard: break a link, the check fails.
- [ ] **Step 2: Write the document** from the existing ADRs, specs and `AGENTS.md` invariants; every control cites its evidence, none is restated. Include RLS (ADR 0009) and the container rules (Task 5).
- [ ] **Step 3: `pnpm check`, commit** `docs(security): threat model with STRIDE and ASVS mapping`.

### Task 7: Whole-slice check

- [ ] **Step 1:** Fresh clone state: `docker compose down -v`, `docker compose up --build`, `pnpm e2e`, `pnpm test`, `pnpm test:db:pooled`, `pnpm check`.
- [ ] **Step 2:** Push to `main`; `gh run list --branch main --limit 1` green, otherwise fix first.
- [ ] **Step 3:** One review of the whole slice by `pruefer` on the middle tier (security change); report state, deviations, open points and the ledger sum, then stop (new session for slice B).

## Self-review

- Spec coverage: A1 → Tasks 1 to 4 (with the recorded deviation), A3 → Task 5, A2 → Task 6, order A1, A3, A2 kept, stop after the slice → Task 7.
- Names used across tasks: `withOwner`, `RLS_SCOPE`, `RLS_SETTING`, `MIGRATION_DATABASE_URL`, `app_runtime`: consistent.
- Task 1 may leave db specs red until Task 2 grants privileges; the plan says to commit them together in that case.
