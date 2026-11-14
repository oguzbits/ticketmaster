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
- The runner spec and the worker's consumer spec assert double bookings above zero for `naive` and
  zero for the other strategies (the consumer spec at the default size, 500 buyers on 100 seats,
  with the API's pool of 20 connections and the production concurrency);
  `pnpm e2e` runs a small pessimistic run through the browser.

Phase 1 (core) was accepted by the owner.

Phase 2, slice A (outbox, queue, dead-letter queue, idempotent consumers) is complete:

- A local AWS emulator (Floci, [ADR 0004](adr/0004-local-aws-emulator.md)) runs in Compose and in
  the test setup; a one-shot service creates the queue `booking-events`, its dead-letter queue
  (redrive after 5 receives) and the bucket `tickets`.
- The payment is claimed (transaction 1, the idempotency key and claim time are stored), charged
  outside any transaction and applied (transaction 2, which also writes the `BOOKING_CONFIRMED`
  outbox row). A retry with the same key finishes the booking after a crash at either point.
- The worker's relay sends unpublished outbox rows to the queue; its consumer handles each message
  ID once (`processed_messages`), deletes a message only after the handler succeeded, and leaves a
  failing or unparsable message to the dead-letter queue. The handler only logs the booking ID.
- `GET /health/ready` reports `signals.outbox` (`stuck` when the oldest unpublished outbox row is older than 300 s).
- Specs: outbox row if and only if the booking is `CONFIRMED`, parallel payments (one process and
  two instances), a crash at each payment step, two relays at once, a relay with a hanging send,
  the consumer against the emulator (duplicate, failure, dead-letter queue, shutdown) and the full
  path from `BookingsService.pay` to the recorded message; `pnpm e2e` runs the booking flow on
  the new payment path.

Phase 2, slice B (confirmation mail and ticket PDF) is complete:

- Each `BOOKING_CONFIRMED` message runs two effects in order, each under its own dedupe name: the
  ticket PDF (pdfkit and qrcode, DejaVu Sans for Turkish glyphs) is rendered and stored in the
  bucket under `tickets/<bookingId>.pdf`, then `bookings.ticket_ready_at` is set; the mail with the
  PDF attached goes out through SMTP (Mailpit locally). The mail reads the PDF back from the store
  and the address from Keycloak, so the message carries IDs only and logs carry IDs only.
- `GET /api/bookings/:id/ticket` streams the PDF to its owner (403 for a foreign booking, 404 for
  an unknown one, a ticket that is not stored yet, or a booking that is no longer `CONFIRMED`).
  `ticketReady` is part of the booking contract; my bookings shows "Ticket is being prepared" and
  then a download button.
- The visibility timeout is 120 s and every external call has its own timeout (S3 10 s, SMTP 10 s,
  Keycloak 5 s, one attempt), so a handler stays inside the timeout instead of sending a heartbeat.
- Specs: renderer, store, sender and address lookup against Mailpit and the emulator, both effects
  through the consumer (redelivery after a failing mail sends one mail and stores one PDF), the
  download route (owner, foreign, unknown, not ready, cancelled) and `ticket.e2e.ts`: pay, one mail
  with the PDF in Mailpit, the downloaded file starts with `%PDF-`.

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

Phase 2, slice A:

- **Readiness stays 200 when the outbox is stuck.** The signal is a field (`ok` or `stuck`), not a
  status change: a worker outage must not make Caddy drop the API instances.
- **The fake payment provider decides by its key.** The result is a pure function of the
  idempotency key and the failure rate, so a retry with the same key gets the same answer; the
  injected random source is gone.
- **The consumer handler grew from a log line to two effects** (slice B): PDF, then mail, each
  deduplicated under its own name, so a failing mail does not render and store the PDF again.
- **A failed payment and a cancel emit no message.** `BOOKING_CONFIRMED` is the only type.
- **The relay bounds itself.** The plan had a job-level time limit; an abandoned run kept going
  and could overlap with the next, so the deadline moved into `OutboxService.relay` and the job
  never gives a run up.

## Open points for the owner

- **Server and domain** for the live demo (Hetzner size, DNS name for HTTPS). Needed only for
  phase 5; the size and the memory budget per container go into an ADR.
- **Private vulnerability reporting** is switched off in the repository settings, but
  [SECURITY.md](../SECURITY.md) points to it. Switch it on under Settings, Advanced Security.
- **Ruleset for `main`** (block force pushes and deletion on the server side) is not set.

## Next

Phase 2, slices A and B are done. Still open from earlier notes:

- Write the runbooks the docs-map entry for the deploy folder points to (`docs/runbooks/`).
- Images are pinned by tag; pin by digest and add resource limits with the container hardening.

## Open points

- **A payment key stays claimed on a `HELD` booking that is never retried.** The expiry job spares
  such a booking for `PAYMENT_GRACE_SECONDS` (120) past its hold and expires it after that; the
  key is not released earlier, and a customer who abandons the payment keeps the seat until then.
- **A charge that throws after the claim leaves the booking stuck.** The key stays claimed on the
  `HELD` booking: the customer cannot cancel it (409, a payment may be in flight) and cannot pay it
  with a new key (409, another payment is in progress) until the hold TTL plus the grace has passed
  and the expiry job releases the seat; only a retry with the same key can finish it. The claim
  should be released on a definite provider error (a response, not a timeout).
- **No refund when a charge succeeds after the booking left `HELD`.** The payment runs outside
  the transaction, so a cancel or an expiry can land while the provider answers. The apply step
  then answers 409, stores nothing and logs the booking ID; the money is not returned. Needs a
  refund call on the provider port and a stored reason.
- **No database guard for one `BOOKING_CONFIRMED` per booking.** The outbox row is written in the
  apply step of the payment; that exactly one row exists per confirmed booking rests on the row
  lock and the status check, not on a unique constraint. A unique index on the booking ID in the
  payload would make it a database guarantee.
- **The outbox relay holds a transaction while it sends.** The rows stay locked (`SKIP LOCKED`
  keeps other relays away) until the batch is sent and marked. A run ends within its deadline
  (30 s): a send that has not answered by then counts as failed and ends the batch; each statement
  is bounded by 10 s, a batch is 20 rows, and the database ends a relay transaction that sits idle
  for 120 s. The job never abandons a run, so runs of one process never overlap. A send that was
  made but not marked is repeated (at least once, consumers dedupe). Selecting, sending outside the
  transaction and marking afterwards would need a claim state on the row.
- **Queue ordering is not guaranteed.** The queue is standard, not FIFO, and the relay may send
  rows out of order after a failure; a consumer must not rely on the order of messages. A mail
  that repeats after a crash between its send and the dedupe commit is accepted: delivery is at
  least once, and a repeated confirmation mail is harmless.
- **Published outbox rows are never deleted.** The table grows with every confirmed booking; a
  retention job (like the simulation retention) is needed before it matters.
- **The queue consumer takes one message at a time** (`receive(1)`, one loop per worker), so its
  throughput is one message per round trip and handler. Batching and parallel loops wait for a
  handler that is slow enough to need them. A message that does not parse or whose
  handler keeps failing is received `MAX_RECEIVE_COUNT` times (visibility timeout 120 s each)
  before it reaches the dead-letter queue; the queue has no replay tool yet.
- **A poison message stalls its consumer loop.** An unparsable message pauses the loop for one
  second per receive, so it costs about `MAX_RECEIVE_COUNT` x (visibility timeout + 1 s) of
  throughput before it reaches the dead-letter queue. A handler that runs longer than the 120 s
  visibility timeout still sees its message delivered again while it works (the dedupe record
  serializes the two); the timeouts of the external calls keep a run well below that.
- **A cancel between the status check and the send still gets a mail.** Both ticket effects read
  the booking status outside their transaction and without a lock, so a customer who cancels in
  that window receives a ticket mail (and the PDF flag may be set on the cancelled booking). The
  download route answers 404 for it. Reading the status in the effect's transaction with a share
  lock would close the window.
- **The dead-letter queue has no replay tool.** A message that reached it (a mail server that was
  down for five deliveries) stays there until someone moves it back by hand.
- **The PDF stays after a cancel and is never deleted.** The download answers 404 for a booking
  that is no longer `CONFIRMED`, but the object remains in the bucket; a retention job (with the
  outbox rows) would remove it.
- **The mail effect costs one Keycloak call per message** (the address is read when the mail is
  sent, not stored). Acceptable at demo volume; a cache or a stored address needs a data-protection
  decision first.
- **The ticket font ships through an npm package** (`dejavu-fonts-ttf`, copied into the images with
  the dependencies) instead of a font file in the repository; replacing it means changing the
  renderer's font path.
- **The MSW passthrough also covers Mailpit** (`LOCAL_MAILPIT_ORIGIN` in
  `apps/api/src/testing/mock-server.ts`), next to the emulator; the same point as above applies:
  register it in the `db` setup only.
- **Db specs assume no other consumer on the shared infrastructure.** A running Compose stack
  (worker, relay) on the same database and queue emulator made the mail-down consumer spec time
  out; under a full parallel run the queue consumer specs and `double books under naive` also
  failed once each and passed on a rerun. Give the specs their own database and queue names, or
  run them with the stack stopped.
- **Offline specs may reach the local AWS emulator.** The MSW passthrough in
  `apps/api/src/testing/mock-server.ts` applies to every spec, not only the `db` project; register
  it in the `db` setup only.
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
- **The simulation stream caps are per process** (50 open streams, counted in memory), like the
  seat-stream caps.
- **Simulation data is kept for one hour.** The worker's retention job deletes the sandbox event of
  every run that ended more than `SIMULATION_RETENTION_SECONDS` ago (seats, bookings, transitions
  and the run go with it), so the comparison table lists the runs of the last hour only. Within
  that hour the event shows in the admin's `GET /api/events` and up to 2000 bookings per run in
  `GET /api/bookings`. The job removes at most 100 events a minute; the starts are bounded by the
  rate limit (5 per minute per address) and the cap of 2 active runs. The cleanup of a demo admin
  deletes its runs together with its events (accepted: the runs go with the visitor).
- **The reaper fails a run after the run timeout (10 minutes) only.** Until then a run of a dead
  worker counts as active and blocks a slot of the cap, and its progress key keeps the last
  `RUNNING` state. The reaped run's final progress has empty metrics. Every worker start leaves a
  consumer name in the consumer group of the stream; they are not removed. A worker that is slower
  than the timeout loses its run: the result it stores late is dropped and the run stays `FAILED`.

## Deliberately left out

- Kubernetes, microservices, Java/Spring, AI features, paid services (see
  [ADR 0001](adr/0001-modular-monolith-and-worker.md)).
