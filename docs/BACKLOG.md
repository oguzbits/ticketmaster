# Backlog

State and open points. Context and phases are in [PLAN.md](PLAN.md).

## State

Phase 0 (foundation) is complete:

- pnpm workspace with `packages/shared`, `apps/api`, `apps/worker` and `apps/web`.
- `pnpm check` (typecheck, ESLint, dependency-cruiser, knip, jscpd, magic-string audit, docs audit,
  Prettier), Husky hooks, agent hooks and settings with their own tests.
- CI: quality, unit tests, build, Compose stack, Trivy with SBOM, Semgrep, gitleaks. Dependabot.
- Product name: `ticketmaster-klon`, with a notice in the UI footer and the README that it is
  unofficial and not affiliated.

Phase 1, slice A (core without identity) is complete:

- Database schema and migrations, with the booking state machine in the domain.
- Four booking strategies (`naive`, optimistic, pessimistic, Redis lock) with the mandatory
  concurrency test: parallel holds of the same seat, double bookings counted per strategy.
- Payment and cancel with idempotency keys; hold expiry as a scheduled job in the worker.
- Docker Compose stack with a one-shot `migrate` service, the API, the worker, web (Caddy),
  Postgres, Redis and Keycloak.
- Public event list and seat map in the web app (status by text, border and fill, every seat
  reachable by keyboard); `/health/ready`; structured request logs with request ID and no headers
  or client addresses.
- `pnpm test:db` runs the database specs against their own database `app_test` (recreated and
  migrated on every run), with its own CI job (Postgres and Redis services, migration drift check).

## Deviations from the plan

- **No SWC for NestJS decorators.** Vitest (Vite 8, Oxc) reads `experimentalDecorators` and
  `emitDecoratorMetadata` from the tsconfig; constructor injection by type was checked by hand.
  `unplugin-swc` is added only if a decorator feature fails under the test transform.
- **TypeScript 6.0, not 7.** Angular 22 and typescript-eslint accept only `<6.1`.
- **`packages/shared` is compiled to `dist`.** The NestJS apps run as plain Node ESM, so they
  import built JavaScript. `pnpm typecheck`, `pnpm test` and `pnpm build` build it first.
- **CI has no end-to-end job yet.** It arrives with the first such test. The `stack` job starts
  the Compose stack and probes the health endpoints through Caddy instead.
- **CI cancels a run in progress only outside `main`,** so every commit on `main` keeps its result.
- **The worker ran as a skeleton in phase 0.** It now runs the hold-expiry job and is part of the
  Compose stack.
- **The live demo moved from phase 1 to its own last phase** (phase 5), together with the deploy
  scripts, the backups and the uptime workflow. Until then the system runs locally with
  `docker compose up`.
- **The optimistic strategy has no retries.** The seat version changes only with a committed hold,
  so a lost race means the seat is taken; retrying could only fail again.
- **`HOLD_OUTCOME.PLACED` instead of `HELD`.** `HELD` is already a seat status; the magic-string
  audit flags the duplicate value.
- **`@angular/router` was added** for the event list and the seat map routes.
- **`CORS_ORIGIN` moved to slice B.** Web and API share an origin behind Caddy and the dev proxy,
  so CORS arrives with the security work.
- **The payment charge runs inside the database transaction** until the outbox replaces it
  (phase 2).

## Open points for the owner

- **Server and domain** for the live demo (Hetzner size, DNS name for HTTPS). Needed only for
  phase 5; the size and the memory budget per container go into an ADR.
- **Private vulnerability reporting** is switched off in the repository settings, but
  [SECURITY.md](../SECURITY.md) points to it. Switch it on under Settings, Advanced Security.
- **Ruleset for `main`** (block force pushes and deletion on the server side) is not set.

## Next: phase 1, slice B

Auth (Keycloak, one-click demo login, roles), the booking flow in the web app (hold, pay, cancel
with the four UI states), basic security (headers, CORS, rate limits) and the live update. The scope
is in [PLAN.md](PLAN.md#phase-1-core). Still open from earlier notes:

- Add an `e2e` script with its CI job.
- Write the runbooks the docs-map entry for the deploy folder points to (`docs/runbooks/`).
- API: OpenAPI export.
- The ESLint rule `no-unknown-parameters` will hit NestJS exception filters
  (`catch(exception: unknown)`); narrow the rule there, do not disable it.
- Development reads no env file; defaults cover the API today. Decide how local secrets are loaded
  when the first one appears (database URL, Keycloak client).
- Images are pinned by tag; pin by digest and add resource limits with the container hardening.

## Open points

- **Initial web bundle is 740 kB**, over the 500 kB warning budget. Zod makes up a large part of it.
  Measure, then decide (lazy routes, `zod/mini`).
- **The event list has no pagination.** The API returns every public event.
- **The worker has no healthcheck and no restart policy** in the Compose stack (phase 5, with the
  container hardening).

## Deliberately left out

- Kubernetes, microservices, Java/Spring, AI features, paid services (see
  [ADR 0001](adr/0001-modular-monolith-and-worker.md)).
