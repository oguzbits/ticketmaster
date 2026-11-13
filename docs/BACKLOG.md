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

Phase 1, slice B (identity, booking flow, live seat map) is complete:

- Keycloak realm with the roles `customer`, `organizer` and `admin`; the API verifies access tokens
  (JWKS) in a default-deny guard; the one-click demo login creates a temporary user with sandbox
  events, the worker deletes it after it expires
  ([ADR 0003](adr/0003-authentication-and-demo-login.md)).
- Customer routes (hold, pay, cancel, list) with ownership checks, organizer routes (venues, create
  event, own events with sales) and the admin strategy switch; rate limits, security headers, CORS
  and a Content-Security-Policy in Caddy.
- Every stored seat change is published to Redis after commit and fanned out as server-sent events;
  the web app shows the seat map live.
- Web: start page with the demo login, session and token refresh, booking flow with the four UI
  states, organizer and admin screens.
- `pnpm e2e` runs Playwright against the Compose stack (booking flow, two tabs on one event,
  role screens), with its own CI job.

Phase 1, slice D (rush simulator) is complete:

- An admin starts a run (buyers, seats, strategy) with `POST /api/simulations`: a fresh sandbox
  event, a `simulation_runs` row and a command on the Redis stream `simulations`. The worker's
  consumer group runs the virtual buyers against `BookingsService.hold`, writes the progress to a
  Redis key, counts the double bookings in SQL and stores the final metrics.
- The API serves the run and a server-sent progress stream; the web app has the simulator page
  (live counters, comparison table of finished runs) behind the admin role.
- The runner spec asserts double bookings above zero for `naive` and zero for the other strategies;
  `pnpm e2e` runs a small pessimistic run through the browser.

## Deviations from the plan

- **No SWC for NestJS decorators.** Vitest (Vite 8, Oxc) reads `experimentalDecorators` and
  `emitDecoratorMetadata` from the tsconfig; constructor injection by type was checked by hand.
  `unplugin-swc` is added only if a decorator feature fails under the test transform.
- **TypeScript 6.0, not 7.** Angular 22 and typescript-eslint accept only `<6.1`.
- **`packages/shared` is compiled to `dist`.** The NestJS apps run as plain Node ESM, so they
  import built JavaScript. `pnpm typecheck`, `pnpm test` and `pnpm build` build it first.
- **The `e2e` CI job arrived with slice B.** The `stack` job stays: it probes the health endpoints
  through Caddy and checks the worker and the migration, without a browser.
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
- **`CORS_ORIGIN` is done** (slice B). Web and API share an origin behind Caddy and the dev proxy,
  so the variable stays unset there.
- **The payment charge runs inside the database transaction** until the outbox replaces it
  (phase 2).

Slice B:

- **No custom exception filter.** Nest maps `HttpException` and hides the internals of everything
  else; a test pins that a 500 body carries no message or stack. This also drops the planned
  narrowing of the `no-unknown-parameters` ESLint rule.
- **Local secrets.** The Keycloak demo client secret is in the committed realm file and is the
  local default of `KEYCLOAK_DEMO_CLIENT_SECRET`, like the Compose credentials (local containers
  only); production requires the variable.
- **The live seat map joined slice B** (it was slice C): the booking flow is not usable without it.
- **`venue_seats.price_cents`** was added (nullable, expand step) so an organizer's event copies
  the prices of its venue; the idempotent seed fills it, making it `not null` is the contract step.
- **Demo-admin scoping.** A demo admin may switch only their own sandbox events, a regular admin
  only public events, so a demo user cannot change what others see.
- **Token refresh goes through the API** (`POST /api/auth/refresh`); the browser never talks to
  Keycloak.
- **The end-to-end run uses its own Compose project** (`ticketmaster-klon-e2e`) and
  `docker-compose.e2e.yml`: payment failure rate 0 and no host ports except web.

Slice D:

- **A run has no `eventId` in the start request.** Every run creates its own sandbox event, so the
  simulator never touches a public event.
- **The run cap counts rows, not a Redis counter.** At most two runs in `QUEUED` or `RUNNING` that
  started within the last 10 minutes; a PostgreSQL advisory lock makes parallel starts safe, and the
  window frees the slot of a run whose worker died.
- **Progress goes through a Redis key** (`simulation:<runId>:progress`, one-hour expiry) that the
  SSE route polls, not through pub/sub: no subscriber connection, no race between a snapshot and a
  subscription, and it works across API instances.
- **All synthetic buyers book as the admin who owns the sandbox event.** A sandbox event accepts
  bookings only from its owner, so the buyers are not separate users.
- **Test helpers live in `@app/api/simulations/testing`**, not in the module barrel, so the
  production code does not export them.

## Open points for the owner

- **Server and domain** for the live demo (Hetzner size, DNS name for HTTPS). Needed only for
  phase 5; the size and the memory budget per container go into an ADR.
- **Private vulnerability reporting** is switched off in the repository settings, but
  [SECURITY.md](../SECURITY.md) points to it. Switch it on under Settings, Advanced Security.
- **Ruleset for `main`** (block force pushes and deletion on the server side) is not set.

## Next

Slice D is done. The phase 1 definition-of-done check against [PLAN.md](PLAN.md#phase-1-core)
follows, then phase 2. Still open from earlier notes:

- Write the runbooks the docs-map entry for the deploy folder points to (`docs/runbooks/`).
- API: OpenAPI export.
- Images are pinned by tag; pin by digest and add resource limits with the container hardening.

## Open points

- **Initial web bundle is about 790 kB**, over the 500 kB warning budget. Zod makes up a large part of it.
  Measure, then decide (lazy routes, `zod/mini`).
- **A running hold is not restored after a reload.** The seat map keeps the customer's hold in the
  page only; after a reload the seat shows as held and the customer can cancel it under "My
  bookings" but not pay it. Reading `GET /api/bookings` on load would restore the payment panel.
- **The venue list and the event list have no pagination.** `GET /api/venues` and
  `GET /api/events` return every row.
- **The busy notices (429, 503 on the seat stream) and the failed-payment and 5xx-retry paths are
  covered by unit tests only.** The end-to-end run pins the payment to succeed and never meets a
  limit.
- **Keycloak orphan users.** When a demo login fails after the Keycloak user was created and the
  compensating delete fails too (or the API stops in between), the user has no `demo_users` row and
  the cleanup job never finds it. The failure is logged with the user ID; a periodic sweep of
  Keycloak users without a row would remove them.
- **An access token stays valid for up to 5 minutes after the demo cleanup.** The guard is
  stateless and a refresh is not refused before the cleanup, so a token refreshed shortly before it
  outlives the deleted Keycloak user. The grace period (`ACCESS_TOKEN_GRACE_SECONDS`) covers only
  tokens issued before `expires_at`. A booking made in that window has no `demo_users` row to
  clean it (a hold still expires by itself).
- **The seat-stream caps are per process** (10 per address, 500 per process, counted in memory).
  With more than one API process they have to move to Redis (phase 2).
- **Chrome reports a Content-Security-Policy `eval` violation** on the web app. The source is not
  traced yet; the policy has no `unsafe-eval`. Find the script that calls `eval` before widening
  the policy.
- **The local development database holds test leftovers** (about 3,400 venues from earlier
  test runs). Reset it with
  `docker compose down -v`; the next `docker compose up` or `pnpm db:migrate` recreates it with the
  seed (this also resets the Keycloak realm, which lives in the same Postgres).
- **The worker has no healthcheck and no restart policy** in the Compose stack (phase 5, with the
  container hardening).
- **Finished runs of a real (non-demo) admin are never cleaned**, and neither are their up to 2000
  `HELD` bookings per run; `GET /api/bookings` of that admin lists them. The cleanup of a demo admin
  cascades into its runs.
- **The simulation stream caps are per process** (50 open streams, counted in memory), like the
  seat-stream caps.
- **A simulation run leaves a sandbox event of up to 500 seats and up to 2000 `HELD` bookings**, and
  every demo visitor is an admin. The growth per client address is bounded only by the rate limit
  (5 starts per minute) and the global cap of 2 active runs. The events of a real admin show in
  `GET /api/events` and are never cleaned.
- **The `naive` double-booking check on the real Compose stack is not automated.** It was done by
  hand during slice D (worker pool 20, concurrency 40; 500 buyers on 100 seats gave 17, 20 and 13
  double bookings, and 0 for the other strategies). The end-to-end run only starts a `pessimistic`
  run.

## Deliberately left out

- Kubernetes, microservices, Java/Spring, AI features, paid services (see
  [ADR 0001](adr/0001-modular-monolith-and-worker.md)).
