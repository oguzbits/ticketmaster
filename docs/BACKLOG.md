# Backlog

State and open points. Context and phases are in [PLAN.md](PLAN.md).

## State

Phase 0 (foundation) is complete:

- pnpm workspace with `packages/shared`, `apps/api`, `apps/worker` and `apps/web`.
- `pnpm check` (typecheck, ESLint, dependency-cruiser, knip, jscpd, magic-string audit, docs audit,
  Prettier), Husky hooks, agent hooks and settings with their own tests.
- API with a validated config module and `GET /health/live`; web app that shows the API status with
  loading, error and retry states.
- Docker Compose stack: Postgres, Redis, Keycloak, API and web (Caddy), all with health checks.
- CI: quality, unit tests, build, Compose stack, Trivy with SBOM, Semgrep, gitleaks. Dependabot.
- Product name: `ticketmaster-klon`, with a notice in the UI footer and the README that it is
  unofficial and not affiliated.

## Deviations from the plan

- **No SWC for NestJS decorators.** Vitest (Vite 8, Oxc) reads `experimentalDecorators` and
  `emitDecoratorMetadata` from the tsconfig; constructor injection by type was checked by hand.
  `unplugin-swc` is added only if a decorator feature fails under the test transform.
- **TypeScript 6.0, not 7.** Angular 22 and typescript-eslint accept only `<6.1`.
- **`packages/shared` is compiled to `dist`.** The NestJS apps run as plain Node ESM, so they
  import built JavaScript. `pnpm typecheck`, `pnpm test` and `pnpm build` build it first.
- **CI has no database-test and no end-to-end job yet.** They arrive with the first such test. The
  `stack` job starts the Compose stack and probes the health endpoint through Caddy instead.
- **CI cancels a run in progress only outside `main`,** so every commit on `main` keeps its result.
- **`/health/ready` is missing.** It arrives with the first adapter it can check (database, Redis).
- **The worker is a skeleton** and not part of the Compose stack: without a consumer or a job the
  process ends right after start.
- **`DESIGN.md` is missing.** It is written with the first real screens in phase 1.
- **The live demo moved from phase 1 to its own last phase** (phase 5), together with the deploy
  scripts, the backups and the uptime workflow. Until then the system runs locally with
  `docker compose up`.

## Open points for the owner

- **Server and domain** for the live demo (Hetzner size, DNS name for HTTPS). Needed only for
  phase 5; the size and the memory budget per container go into an ADR.
- **Private vulnerability reporting** is switched off in the repository settings, but
  [SECURITY.md](../SECURITY.md) points to it. Switch it on under Settings, Advanced Security.
- **Ruleset for `main`** (block force pushes and deletion on the server side) is not set.

## Next: phase 1

The scope is in [PLAN.md](PLAN.md#phase-1-core). Notes from phase 0 that matter there:

- Add `test:db` and `e2e` scripts with their CI jobs (Postgres and Redis as services).
- Add the docs-map entry for the database schema (`docs/data-model.md`) with the first migration.
  The entries for `packages/shared/src/` and the deploy folder already exist; their documents
  (`docs/api/`, `docs/runbooks/`) do not yet.
- Worker: add the Dockerfile target and the Compose service with its first job, and export the API
  modules the worker needs (package `exports` of `@app/api`).
- API: pino logging with request ID, OpenAPI export, global `/api` prefix (Caddy already proxies
  `/health/*`), `/health/ready`.
- The ESLint rule `no-unknown-parameters` will hit NestJS exception filters
  (`catch(exception: unknown)`); narrow the rule there, do not disable it.
- Web: Zod makes up a large part of the initial bundle (the 500 kB budget warns). Measure, then
  decide (lazy routes, `zod/mini`).
- Development reads no env file; defaults cover the API today. Decide how local secrets are loaded
  when the first one appears (database URL, Keycloak client).
- Images are pinned by tag; pin by digest and add resource limits with the container hardening.

## Deliberately left out

- Kubernetes, microservices, Java/Spring, AI features, paid services (see
  [ADR 0001](adr/0001-modular-monolith-and-worker.md)).
