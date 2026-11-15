# Phase 4: Hardening and polish, design

Context: [PLAN.md](../../PLAN.md), phase 4. This spec fixes the split into slices and designs
slice A (security) in detail. Slices B and C get their own spec when they start.

## Slices

| Slice | Content                                                                         |
| ----- | ------------------------------------------------------------------------------- |
| A     | Row-level security, threat model, container hardening                           |
| B     | Mutation tests (Stryker) on `core/` and the `domain/` folders                   |
| C     | Changelog, `v0.1.0`, final README, architecture diagrams, demo GIF (Playwright) |

Out of scope for phase 4: bilingual UI (owner decision), everything of phase 5 (server, deploy,
runbooks, backups).

## Slice A

### A1. Row-level security

**Goal.** A customer query that forgets its ownership filter still returns nothing foreign (second
layer of invariant 2).

**Findings that shape the design.**

- The app connects as `app`, which `POSTGRES_USER` makes a superuser, so RLS would not apply.
- Many production paths read `bookings` across users on purpose: seat availability in
  `insert-hold`, sales counts in `events.service`, `publish-seat-change`, the expiry job, ticket
  effects in the worker, demo cleanup. A policy of only `user_id = current user` would break them.

**Design.**

1. Two roles. `app` (owner, superuser) runs migrations and the seed only. A new role
   `app_runtime` (no superuser, not owner, no `BYPASSRLS`) is the login of API and worker. It is
   created by a script in `docker/postgres/` (initdb) and gets table privileges by `GRANT` in a
   custom migration. `DATABASE_URL` is the runtime URL; a new `MIGRATION_DATABASE_URL` is used by
   `migrate.ts` only (config module, `.env.example`, Compose, CI).
2. Custom migration (`drizzle-kit generate --custom`, never edited after generation) enables and
   forces RLS on `bookings` and `booking_transitions` (user-owned data). Policy for all commands:
   `user_id = current_setting('app.user_id', true)::uuid OR current_setting('app.scope', true) = 'system'`.
   `booking_transitions` follows through its booking.
3. A small helper in the database module runs a callback in a transaction and sets
   `set_config('app.user_id', …, true)` (transaction-local, required by PgBouncer in transaction
   mode, [ADR 0005](../../adr/0005-pgbouncer-transaction-mode.md)) or `app.scope = 'system'`.
   Customer routes (`hold`, `pay`, `cancel`, `listOwn`, `getOwn`, ticket download) use the user
   form with the ID from the verified token. Every other path names the system scope explicitly.
   The request that sets neither sees no rows (fail closed).
4. ADR 0009 records the decision, the rejected alternatives (policies in the drizzle schema with
   `pgPolicy`; views with `security_definer` for the aggregates; RLS without a system scope) and
   the known limit: the system scope is a session variable, so code that can run arbitrary SQL can
   set it. RLS guards against a forgotten filter, not against SQL injection.

**Behavior rules.**

- With `app.user_id` set to user A, a `SELECT`, `UPDATE` or `DELETE` of a booking of user B affects
  zero rows; an `INSERT` with another `user_id` is refused.
- Without either setting every statement on the two tables sees zero rows.
- The `naive` strategy and the concurrency test behave as before.

**Test cases** (database specs, `pnpm test:db`; each names the protection whose removal turns it
red):

1. Foreign read returns nothing (remove the policy).
2. Foreign update and delete touch zero rows (remove the `USING` clause for those commands).
3. Insert with a foreign `user_id` is refused (remove `WITH CHECK`).
4. No setting at all sees no rows (make the policy default to permissive).
5. System scope sees all rows (needed by the cross-user paths).
6. The setting does not leak to the next transaction on the same pooled connection (use
   `set_config(…, false)`).
7. `app_runtime` is neither superuser nor `BYPASSRLS` (switch the API URL to `app`).
8. Existing booking, expiry, simulator and concurrency specs stay green against `app_runtime`.

**Docs.** `docs/data-model.md` (policies), ADR 0009, `.env.example`, README and CONTRIBUTING
(setup), threat model (A2).

### A2. Threat model

`docs/security/threat-model.md`: one STRIDE table per trust boundary (browser to Caddy, Caddy to
API, API to Postgres, API/worker to Redis, worker to SQS and S3, API to Keycloak), each threat with
its control and the test or document that proves it, plus an ASVS mapping (V2, V3, V4, V5, V8,
V13, V14). The residual risks come from [BACKLOG.md](../../BACKLOG.md) (no refund, no breaker, no
audit retention). It links controls instead of restating them. A spec checks that every linked
path exists (same idea as the docs audit).

### A3. Container hardening

- Pin every image in `docker-compose.yml` by tag and digest.
- Per service where the image supports it: `read_only` with `tmpfs` for writable paths,
  `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `mem_limit` and `cpus`.
  Infrastructure images that need a writable data directory or extra capabilities (Postgres,
  Keycloak, Grafana stack) keep only what they need; each exception carries a one-line reason.
- A spec parses the Compose files and fails for a service without digest, limits or an
  exception comment (remove a limit, the spec turns red).
- The memory budget per container feeds the phase 5 ADR on the server size. The numbers come
  from `docker stats` during `pnpm load`, not from guessing.
- Trivy stays as it is in CI.

### Order and stop

A1, then A3, then A2 (the threat model cites both). One commit per topic, push to `main` when the
hooks are green, check CI. Stop after slice A with a short report.

## Risks

- A1 touches every data path; the list of cross-user paths above is the checklist, and the
  database specs of the existing modules are the net.
- Some images may not run read-only; those become documented exceptions, not silent omissions.
- Not yet checked: that Stryker works with Vitest 4 and ESM (slice B), and that `ffmpeg` is
  installed (slice C).
