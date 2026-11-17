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
  PDF attached goes out through SMTP (Mailpit locally). Both effects read the booking inside their
  transaction with a share lock so a concurrent cancel waits or skips them. The mail reads the PDF
  back from the store and the address from Keycloak, so the message carries IDs only and logs carry
  IDs only.
- `GET /api/bookings/:id/ticket` streams the PDF to its owner (403 for a foreign booking, 404 for
  an unknown one, a ticket that is not stored yet, or a booking that is no longer `CONFIRMED`).
  `ticketReady` is part of the booking contract; my bookings shows "Ticket is being prepared" and
  then a download button. `TicketRetentionJob` removes stored PDFs of cancelled bookings and clears
  `bookings.ticket_ready_at`; `DemoCleanupJob` removes stored PDFs of expired demo users before
  deleting their bookings.
- The visibility timeout is 120 s and every external call has its own timeout (S3 10 s, SMTP 10 s,
  Keycloak 5 s, one attempt), so a handler stays inside the timeout instead of sending a heartbeat.
- Specs: renderer, store, sender and address lookup against Mailpit and the emulator, both effects
  through the consumer (redelivery after a failing mail sends one mail and stores one PDF), the
  download route (owner, foreign, unknown, not ready, cancelled) and `ticket.e2e.ts`: pay, one mail
  with the PDF in Mailpit, the downloaded file starts with `%PDF-`.

Phase 2, slice C (several API instances, PgBouncer) is complete:

- Compose runs two `api` replicas; Caddy finds them by DNS (`dynamic a`, refreshed every 2 s), round
  robin, a failed connection is retried on the other replica for up to 5 s and a failed replica is
  skipped for 10 s. `failover.e2e.ts` stops one replica and expects no failed request.
- PgBouncer 1.26.1 in transaction mode sits between the API replicas, the worker and PostgreSQL
  ([ADR 0005](adr/0005-pgbouncer-transaction-mode.md)); `migrate` connects directly. `pnpm
test:db:pooled` runs every database spec through it and CI runs that form.
- The seat-stream (total and per address) and simulation-stream caps count expiring slots in Redis
  (`SlotLimiter`), so they hold across replicas; `stream()` is async because the check is.
- A spec with two API instances proves a hold through one reaches a viewer on the other and that
  the per-address cap counts both.

Phase 2, slice D (virtual waiting room) is complete:

- `events.waiting_room_capacity` (null: no waiting room) and `PUT /api/events/:id/waiting-room/settings`
  (organizer of the event, or admin); `CreateEventRequest` takes the same optional capacity. The
  queue and the admissions live in Redis, one sorted set each per event.
- A customer joins, leaves and reads the position with `/api/events/:id/waiting-room`; a server-sent
  stream follows the position. `BookingsService.hold` asks the waiting room for an admission (through
  `BookingPorts`) and answers 403 without one.
- The worker's admission job runs every second: `planAdmissions` (pure) picks the head of the
  queue, an atomic Redis script moves them and never passes the capacity. An admission lasts five
  minutes.
- Web: the waiting-room panel on the seat map (join, live position, countdown, leave while waiting or admitted); seats
  stay `aria-disabled` until the customer is admitted.
- The public seed event Waiting Room Night (capacity 1) shows the queue with two customers, and
  `waiting-room.e2e.ts` runs it: customer A is admitted and holds a seat, customer B waits at
  position 1 with gated seats and is admitted after A leaves.

Phase 2, slice E (infrastructure as code) is complete:

- The queues, the redrive policy and the bucket are declared once (`INFRASTRUCTURE`,
  `packages/shared/src/aws.ts`) and converged by `scripts/infrastructure.mjs`; the one-shot
  `aws-init` runs it and `api` and `worker` wait for it ([ADR 0006](adr/0006-infrastructure-as-code.md):
  SDK script, not OpenTofu).
- Applying twice sends no mutating call, a missing queue is recreated, a drifted attribute is set
  back (`scripts/infrastructure.test.mjs`; also run by hand against the emulator).

Phase 3, slice A (tracing and correlated logs) is complete
([ADR 0007](adr/0007-tracing-with-opentelemetry.md), [observability.md](observability.md)):

- A preload and an SDK assembled from `sdk-trace` parts (OTLP/HTTP export, always-on sampling);
  driver spans for postgres.js and node-redis through diagnostics channels; HTTP, Express and AWS
  SDK instrumentation.
- `trace_id` and `span_id` on every log line written inside a trace.
- The trace context travels through `outbox_messages.traceparent` and the SQS message attribute, so
  a payment, the relay and both queue effects are one trace.
- One `booking.hold.strategy` span per hold strategy call.
- Compose profile `observability` with Tempo, Loki, Alloy and Grafana (provisioned data sources
  with trace-to-logs and logs-to-trace links). Start it with
  `TRACING_ENABLED=true docker compose --profile observability up --build -d`.
- A simulator run stores the `traceparent` of its start request (`simulation_runs.traceparent`) and
  runs inside that trace; with `GRAFANA_URL` set, a finished run shows a "Trace" link.

Phase 3, slice B (metrics, dashboards, alerts) is complete
([ADR 0008](adr/0008-metrics-with-opentelemetry.md), [observability.md](observability.md)):

- `METRICS_ENABLED`, `METRICS_PORT` and `METRICS_HOST` start a Prometheus exporter on its own
  listener in the API and the worker; the RED histogram of the HTTP instrumentation labels by route
  template (`UNMATCHED` for a request no route matched).
- Business counters through one port (`BusinessMetrics`): holds by strategy and outcome, settled
  bookings by status, queue effects by outcome; each counted after the commit.
- Worker-only gauges: oldest outbox row age, queue depth (booking queue and dead-letter queue) and
  waiting room length; `tm_db_queries_active` in API and worker.
- Prometheus in the `observability` profile, four provisioned Grafana dashboards and seven alert
  rules (booking error ratio, hold and payment latency, stuck outbox, dead-letter queue, missing
  worker gauge, scrape target down). Start it with
  `TRACING_ENABLED=true METRICS_ENABLED=true docker compose --profile observability up --build -d`.
- A spec checks the dashboards and rules against the metric names in the code and the thresholds
  against `OUTBOX_STUCK_SECONDS`, the pool size and the written SLOs, and that this document names
  every instrument.

Phase 3, slice C (audit log) is complete
([data model](data-model.md), [plan](superpowers/plans/2026-11-14-phase-3-slice-c.md)):

- Table `audit_log` (append-only by code: `AuditService.record` is the only writer) and
  `GET /api/audit-log` (admin only, filter by action and actor, keyset pagination, newest first).
- Seven actions, each written in the transaction of the change: booking held, paid, cancelled, event
  created, strategy switched, waiting-room settings changed, simulation started (an eighth,
  `PAYMENT_REFUNDED`, was added with the refund of a late charge). Rows hold IDs only.
- `@RequestId()` hands the request ID to the services; a client `x-request-id` counts only if it is a
  plain token, otherwise the API generates a UUID.
- Admin page `/admin/audit-log` with the four UI states; the end-to-end spec of the strategy switch
  opens it.

Phase 3, slice D (k6 and event cache) is complete
([load tests](load-tests.md), [plan](superpowers/plans/2026-11-14-phase-3-slice-d.md)); phase 3 is
done:

- `CacheAside` on Redis (fail open on a Redis error, a value that no longer parses counts as a miss)
  and the cache of the public event list and layouts for `EVENT_CACHE_TTL_SECONDS` (30, `0` switches
  it off); seat status and sandbox events never go through it; the strategy switch, the waiting room
  settings and event creation invalidate it after their commit.
- Metric `tm_cache_requests_total` (`cache`, `result` `HIT`, `MISS`, `ERROR`) and the panel
  `Event cache hit ratio` on the `API` dashboard.
- k6 scenarios `browse`, `booking-flow`, `rush`, `waiting-room` and `pnpm load` against the Compose
  stack with `docker-compose.loadtest.yml`. Result: the cache cut the median of the event reads by
  about 0.4 ms at 200 requests per second with a hit ratio of 99.97 %, nothing more at that rate.

Phase 4, slice A, row-level security is complete
([ADR 0009](adr/0009-row-level-security.md), [data model](data-model.md)):

- API and worker connect as `app_runtime`; the migration job runs as the owner
  (`MIGRATION_DATABASE_URL`) and creates the role with the password of `DATABASE_URL`.
- Policies on `bookings` and `booking_transitions` restrict rows while a transaction is in the user
  scope (`withOwner`); the booking list and the pay and cancel transitions use it.

Phase 4, slice A, container hardening and threat model are complete
([container hardening](../CONTRIBUTING.md#container-hardening),
[threat model](security/threat-model.md)):

- Images and `FROM` lines carry tag and digest; every service has limits from measured peaks,
  dropped capabilities and a read-only root, with one named exception (Keycloak `start-dev`); a
  spec enforces this.
- `docs/security/threat-model.md`: STRIDE per boundary, ASVS 5.0 mapping and residual risks.

Phase 4, mutation tests are complete (`pnpm mutation`, `stryker.config.mjs`):

- StrykerJS mutates the pure domain code (`modules/*/domain` and `src/core`) and runs the offline
  API specs (`vitest.mutation.config.ts`). The first run scored 89 %; the survivors showed unpinned
  values (the S3 key of a ticket, the Redis channel, the Grafana link parameters, the anchors of
  the `traceparent` check, the error text), each now has a spec. The score is 100 %.
- A weekly workflow (`mutation.yml`, also on demand) fails below 90 and keeps the HTML report.
- Two mutants are switched off in the code with a reason: the null branch of `traceLink`
  (equivalent) and `SYSTEM_ACTOR_ID` (only the database specs read it). The database specs and
  the worker are not part of the run.

Phase 4, changelog and demo GIF are complete:

- `CHANGELOG.md` (Keep a Changelog, SemVer) holds `0.1.0` (tagged `v0.1.0`) and `[Unreleased]`.
- `docs/demo.gif` sits at the top of the README: two windows on one event, a visitor who is not
  signed in and a customer who holds and pays; `pnpm demo:gif` records it again against the
  running stack (Playwright and ffmpeg). Recording leaves a sold seat in the local database.

Phase 4, module graph complete ([architecture.md](architecture.md)):

- The module graph (API modules, `infrastructure`, `core`, the worker) is a generated block of
  `docs/architecture.md`, built by `pnpm docs:generate` from the dependency-cruiser result;
  `pnpm check` fails when it is stale. dependency-cruiser does not resolve the worker's
  `@app/api/...` imports, so the generator maps them through the `exports` of the API package.
- Not drawn: `packages/shared` and the config module (every module uses them), specs and test
  support. The Mermaid rendering was not looked at in a viewer.

Stage look, slices 1 to 3 complete
([spec](superpowers/specs/2026-11-15-stage-look-redesign-design.md),
[plan](superpowers/plans/2026-11-15-stage-look-slices-1-3.md)):

- Dark semantic tokens with a contrast spec for every token pair, the `.btn-secondary`, `.card`,
  `.badge` and `.event-art` primitives, the app shell with a wordmark and a search field, the start
  page with role cards, the event list as a card grid with client-side search, and the event page
  with the seat map and a booking side panel. No API or contract change. Slices 4 and 5 follow
  below.
- Deviations from the spec: no lowest price on the event card (`EventSummary` carries none and the
  contract stays; prices are on the event page); the glyph is decorative, picked from the event id
  (events have no category); search is in scope because the list is complete in the browser; the
  accent is magenta, not amber (amber is the held seat); the strategy label showed only on the list
  card and the event page; slices 4 and 5 extended it to the other pages.
- Deviations from the plan: `.btn-secondary` replaced four identical buttons, not three (the
  waiting room panel has one too); the contrast spec reads `styles.css` through `node:fs`, which
  needs the declaration `apps/web/src/node-fs.d.ts` because the web app has no Node types; the hash
  in `event-art.ts` mixes its bits at the end, otherwise ids that differ in the last character got
  the same glyph; below `lg` the booking panel is `sticky` at the bottom, not `fixed` with
  measured padding (its height varies, sticky leaves the last seat row reachable) and hides the
  price categories while pinned; the panel shows the hint to pick a seat only when holding is
  possible (not while a waiting room blocks it); the waiting room panel lost its own box inside
  the panel card; the venue name uses `wrap-anywhere` so an unbreakable name cannot widen a flex
  row; on a phone (`max-lg`), the waiting-room panel moves above the seat map while gated, and
  focused seats use `scroll-mb` to stay clear of the sticky booking panel.

Stage look, slice 4 complete
([plan](superpowers/plans/2026-11-15-stage-look-slices-4-5.md)):

- My bookings as cards with a status badge, the organizer events as art cards with the strategy
  label, the create form as a card. New `.field` primitive for form controls (the class string
  repeated ten times); the admin pages adopt it in slice 5. No API or contract change.
- Deviations from the plan: `MyBookings` gets a flex host (`gap-4`) like the other pages; without
  it the heading touched the list and `self-start` did nothing, which was already so before.
- Verified in the browser: the organizer page at 1280 and 390 px (a 120-character name wraps, an
  empty submit shows the alert) and my bookings at 390 px with one confirmed booking. The loading,
  error and empty states are covered by the unit specs and were not forced in the browser.

Stage look, slice 5 complete, which completes the stage look
([plan](superpowers/plans/2026-11-15-stage-look-slices-4-5.md)):

- The strategy switch, the rush simulator and the audit log use `.card` and `.field`. The
  strategy is read as its label on both admin pages (option text, current strategy, confirm and
  result sentences, current run, comparison row header); option values, request bodies,
  `Status: FINISHED` and the audit action names stay raw. No API or contract change.
- Deviations from the plan: `simulator.e2e.ts` changed, because it asserted the raw strategy in
  the comparison row (the plan assumed the e2e specs stay as they are); the spec imports
  `strategyLabel` from the web app. The spec calls "charts restyled" for slice 5; the app has no
  charts, so there was nothing to restyle.
- Verified in the browser at 390 px: the simulator with a `NAIVE` run (nine seats sold twice),
  the audit log (the page does not scroll sideways, the table scrolls inside its card) and the
  strategy switch up to its confirmation. Not forced in the browser: the error and reconnect
  states, which the unit specs cover.
- The `<progress>` of a simulator run rendered green in Chrome; fixed in the light portal redesign
  below.

Light portal redesign complete
([plan](superpowers/plans/2026-11-15-light-portal-redesign.md)):

- The tokens are light: cool-gray page, white cards, indigo accent, `--shadow-card` and the
  `.card-link` primitive; `color-scheme: light`. The contrast spec asserts a light theme and a
  visible divider, and every pair still holds on both surfaces. The start page has an indigo hero
  with a search form that fills the shared search query and opens the event list. Header and
  footer sit on white. The event list and event page use white cards with a soft shadow, the seat
  map sits in a card next to the booking panel, and the account, organizer and admin pages use
  light cards, tiles and tables. The dark stage look is replaced; "dark theme, no theme switch"
  of the [stage look spec](superpowers/specs/2026-11-15-stage-look-redesign-design.md) no longer
  holds. No API or contract change.
- Deviations from the plan: two existing specs changed because the hero adds a second search form
  and a submit button (the header search selector is scoped to `header`, the double-click test
  looks at the role buttons only).
- The native `<progress>` of a simulator run took the browser's green; `accent-color` on `:root`
  now gives it the indigo accent.
- Verified in the browser at 1280 and 390 px: the start page and its search, the event list
  (including a 120-character unbreakable event name at 390 px with no horizontal overflow) and
  event page, my bookings, the organizer page (empty submit shows the name error), the simulator
  with a finished run, the audit log, and the focus ring on white.

Enterprise production alignment, slice 1 (production config guards and S3 presigned ticket downloads):

- `DEMO_LOGIN_ENABLED` and `UNSAFE_STRATEGIES_ENABLED` default to `false` in `EnvSchema` (local
  defaults and `docker-compose.yml` enable them explicitly so the local stack and `pnpm e2e` keep
  working). When `false`, `POST /api/demo-login` answers 403 and creating, switching, simulating or
  holding under `NAIVE` answers 400 (`isStrategyAllowed` in `apps/api/src/core`).
- `GET /api/bookings/:id/ticket` returns a 60 s presigned S3 URL (`TicketDownloadSchema`: `{ url, expiresAt }`)
  with `ResponseContentDisposition: attachment` instead of proxying the PDF bytes through the API.
  `S3_PRESIGN_BASE_URL=/storage` in Compose lets Caddy proxy `/storage/*` to `aws:4566` with `Host: aws:4566`
  so browser downloads and `pnpm e2e` share the origin without exposing the emulator port.
  Note: Floci accepts presigned `GetObject` parameters cleanly but does not reject tampered
  `X-Amz-Signature` values (real S3 enforces SigV4).

Enterprise production alignment, slice 2 (AWS SESv2 mail transport):

- `MAIL_PROVIDER` (`ses` | `smtp`) defaults to `ses` in production (`SMTP_URL` optional unless `smtp`)
  and `smtp` outside production (local Mailpit UI and `ticket.e2e.ts` stay untouched unless
  `MAIL_PROVIDER=ses` is chosen).
- `SesMailSender` (`@aws-sdk/client-sesv2`) builds RFC 2822 raw MIME messages with the PDF
  attachment and sends through `SESv2Client` (`maxAttempts: 1`, 10 s timeout).
- `INFRASTRUCTURE` (`packages/shared/src/aws.ts`) declares `SES_IDENTITY.TICKETS_FROM`, converged
  by `aws-init` (`GetEmailIdentity` / `CreateEmailIdentity`), and verified against Floci 2.4.0
  (`MessageRejected` without verified identity, `/_aws/ses` attachment round-trip).

Enterprise production alignment, slice 3 (OpenTofu IaC):

- Shared OpenTofu module `infra/modules/messaging` declares the SQS queues (`booking-events`,
  `booking-events-dlq`, redrive policy), S3 `tickets` bucket (public access block, versioning,
  SSE-KMS, lifecycle, conditional TLS-only bucket policy), and SESv2 sender identity.
- `infra/local` targets Floci (`kms`, `s3`, `sqs`, `sesv2`, `sts`) and passes full `apply` ->
  `plan -detailed-exitcode` -> `destroy`; `scripts/infrastructure.mjs` stays the sub-second Compose
  bootstrapper while `scripts/infra-parity.test.mjs` prevents drift against
  `packages/shared/src/aws.ts` ([ADR 0006](adr/0006-infrastructure-as-code.md)).
- `infra/aws` declares the full AWS production blueprint (2-AZ VPC with Flow Logs and VPC
  endpoints, KMS with rotation, Secrets Manager, least-privilege Security Groups & ECS IAM roles,
  RDS PostgreSQL 18 Multi-AZ + RDS Proxy, Multi-AZ ElastiCache Redis, Cognito User Pool, ECS
  Fargate `api`/`worker`, internal HTTPS ALB, and Regional WAFv2), validated by `pnpm infra:validate`,
  `pnpm infra:trivy` (zero HIGH/CRITICAL findings), and CI.

Enterprise production alignment, slice 4 (payment reconciliation and signed waiting-room admission tokens):

- `payment_attempts` table (`migration 0015`) tracks every charge lifecycle state (`CLAIMED`,
  `CHARGED`, `APPLIED`, `REFUND_PENDING`, `REFUNDED`, `RELEASED`); `PaymentReconciliationJob`
  runs every 30 s in `apps/worker` to settle crashed `CHARGED` confirmations, retry `REFUND_PENDING`
  late refunds (with `PAYMENT_REFUNDED` audit rows), and probe stale `CLAIMED` rows via `payments.lookup`.
- `WaitingRoomService` signs an HS256 JWT (`admissionToken`, `jose`, `WAITING_ROOM_SIGNING_SECRET`,
  `min 32` chars) bound to `sub`, `eventId`, and `admittedUntilMs`; `POST /api/bookings` verifies
  both the signed token (when provided, or required alongside) and active Redis admission so
  `DELETE /api/events/:id/waiting-room` revokes tokens immediately. Angular `WaitingRoomStore` and
  `SeatMap` forward `admissionToken` transparently on seat holds.

Enterprise production alignment, slice 5 (observability hardening, burn-rate alerts, and web bundle + browser tracing):

- `docker-compose.yml` adds hardened `alertmanager` (`127.0.0.1:9093`, `docker/observability/alertmanager.yml`
  with grouping and inhibition rules), sets Prometheus retention to 30 days, and `alerts.yml` adds
  multi-window 30-day SLO burn-rate alerts (`BookingErrorBurnFast` at `14.4x`, `BookingErrorBurnSlow`
  at `6x`).
- Tree-shaking Zod named exports across `packages/shared` (`"sideEffects": false`) cut the Angular
  initial bundle from ~756 kB to ~422 kB raw (~116 kB transfer), well within the tightened `450 kB`
  warning / `500 kB` error budget.
- Angular `HttpClient` uses `withFetch()`, and `apps/web/src/app/telemetry/telemetry.ts` (~71 kB
  lazy chunk) loads post-bootstrap only when `GET /health/live` signals `tracing: true`, exporting
  scrubbed browser spans same-origin via `/v1/traces` (proxied by Caddy to `tempo:4318`) with W3C
  `traceparent` propagation.

Enterprise hardening follow-ups:

- `CacheAside` (`apps/api/src/infrastructure/cache/cache-aside.ts`) coalesces concurrent misses per
  cache key in-process (singleflight) and marks active loads stale on `invalidate` so a pre-commit
  reader cannot write stale values back after invalidation.
- `audit_log` (`migration 0016`) enforces append-only at the PostgreSQL layer by revoking `UPDATE`
  and `DELETE` from `app_runtime` and installing a `BEFORE UPDATE OR DELETE` trigger.
- `TRACING_SAMPLE_RATIO` (`0..1`, default `0.05` in production, `1` locally and in Compose)
  configures root trace sampling via `TraceIdRatioBasedSampler` inside `ParentBasedSampler`.

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
- **No public live demo.** The owner dropped it (phase 5 with the deploy scripts, backups and
  uptime workflow). The system runs locally with `docker compose up`.
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

Slice C:

- **The cross-instance proof is a database spec, not an end-to-end spec.** Two Nest apps in one
  process share the database and Redis; the browser run cannot address one replica, so it checks
  the failure of a replica instead.
- **No `prepare: false` on the driver.** Drizzle sends unnamed statements; the pooler runs with
  `max_prepared_statements` 200 and a spec with named statements guards it.
- **`pnpm test:db` stays direct, CI runs the pooled form.**

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

Slice D:

- **One column, not two.** `waiting_room_capacity` is null or a positive number; a separate
  enabled flag could only contradict it.
- **The settings route is `PUT /api/events/:id/waiting-room/settings`.**
- **The position stream polls Redis once a second per open stream**, like the simulation progress
  stream, instead of a subscription; that works across API replicas without extra wiring.
- **The admission is checked in `BookingsService.hold` through `BookingPorts`,** so every caller of
  `hold` shares one check.
- **The end-to-end spec uses a public seed event** (Waiting Room Night), not an event the organizer
  creates: an organizer's event is a sandbox event that a second customer cannot see. The booking
  and admin specs changed with it (shared customer session; the admin opens a sandbox event by
  name) to stay under five demo logins a minute and to not depend on the list order of events that
  start at the same time.

Phase 3, slice A:

- **postgres.js and node-redis instead of `pg` and `ioredis`.** The project uses those drivers; the
  spans come from their diagnostics channels, not from an instrumentation package.
- **The trace context is stored on the outbox row** (`traceparent`), because the relay runs in the
  worker, long after the request ended.
- **The consumer span is a child of the send span**, not a span link: one trace for the whole
  payment.
- **Alloy instead of Promtail** to ship the container logs to Loki.
- **No browser spans.** The API's server span is the root.
- **`NodeSDK` is not used:** it reads `OTEL_*` and starts metric and log exporters.
- **`instrumentation-express` was added** to name the server span after the route template.
- **`/health/*` requests are ignored** (polled by the container health checks).
- **The preload path is `./dist/tracing.preload.js`** in the Docker command.

Phase 3, slice B:

- **Alert rules are Prometheus rule files,** not Grafana-managed rules: plain PromQL, checked with
  `promtool`.
- **Pool saturation is in-flight queries.** postgres.js exposes no pool statistics, so an up-down
  counter of queries in flight is compared with the pool size on the dashboard.
- **`METRICS_ENABLED` is separate from `TRACING_ENABLED`;** the profile needs both.
- **The exporter writes gauges as deltas** (`ScrapeExporter`), so a gauge whose source is down is
  absent from the scrape instead of 0 or stale. `GaugeSourceMissing` watches for it.
- **`METRICS_HOST` defaults to `127.0.0.1`;** Compose sets `0.0.0.0` so Prometheus can reach the
  listener, and does not publish the port.
- **`startTelemetry` is shared by both preloads** (API and worker), so tracing and metrics start
  through one function.
- **Prometheus names differ from the plan:** no `_seconds`, and the HTTP labels are the semconv
  names (`http_route`, `http_request_method`, `http_response_status_code`).

Phase 3, slice C:

- **A service, not a separate port interface.** `AuditService` takes the caller's transaction like
  `OutboxService`; a second layer would only forward the call.
- **The simulator's holds are not audited.** A run makes up to 2000 holds without a request; the
  start of the run is audited.
- **`SIMULATION_STARTED` is written after the enqueue**, in its own transaction, so a failed start
  leaves no row. A failure of that last write discards the event while the start command may
  already sit in the stream; the worker finds no run.
- **The cursor is the identity ID.** A row with a lower ID that commits after a reader passed it is
  missed by that reader.

A running hold survives a reload: the seat map reads `GET /api/bookings` for a customer and shows
the held, unexpired booking of its event in the payment panel (`BookingsStore.restore`). A payment
that was on its way before the reload starts a new attempt with a new key; the server answers 409
while the first is still running. No API or contract change.

## Next

Phases 0 to 4 are done; phase 5 (live demo) is dropped. The [runbooks](runbooks/README.md) cover
the running stack (dead-letter queue, stuck outbox, a service down). What is left is the list of
open points below.

## Open points

- **Row-level security is opt-in.** A customer path that does not call `withOwner` has no database
  layer; the ticket download and `claimPaymentKey` are such paths on purpose (ADR 0009). The user
  scope is a session variable, so it does not stop SQL injection.
- **The public event list and layouts are cached for `EVENT_CACHE_TTL_SECONDS` (30).** Only the
  strategy switch, the waiting room settings and event creation invalidate them; a change by any
  other path (SQL by hand) shows up after the TTL. Seat status and sandbox events are never cached.
- **During a Redis outage, a frozen server leaves timed-out commands queued until socket reset.**
  The breaker admits a single probe call once the 5 s open window expires (while concurrent calls
  still fail fast), so at most one 250 ms timeout hits Redis per recovery window.
- **No retention of audit rows.** The table only grows.
- **The actor filter takes an ID, not a name.** The audit page filters by a pasted actor ID (checked as a UUID, applied on change); there is no user lookup, because rows hold IDs only.
- **The infrastructure script never deletes.** A resource removed from `INFRASTRUCTURE` stays in
  the account until it is deleted by hand ([ADR 0006](adr/0006-infrastructure-as-code.md)).
- **A closed tab stays admitted until the admission runs out** (five minutes) and can fill the
  capacity meanwhile. No presence heartbeat drops it earlier.
- **Joins in the same millisecond are ordered by user ID** (the sorted set breaks a score tie by
  member).
- **The queue keys of a deleted event expire after a day**, not at once.
- **One `ZRANK`/`ZSCORE` read per open stream per second.** The waiting-room stream cap (200) is
  counted over all API replicas together. The stream emits a heartbeat every 15 s and reconnects
  after 3 s if three heartbeats are missed.
- **A payment key stays claimed on a `HELD` booking that is never retried.** The expiry job spares
  such a booking for `PAYMENT_GRACE_SECONDS` (120) past its hold and expires it after that; the
  key is not released earlier, and a customer who abandons the payment keeps the seat until then.
- **A charge that throws without saying it did not charge relies on `payments.lookup` once stale.**
  The key stays claimed on the `HELD` booking until `RECONCILE_STALE_SECONDS` (60 s) or the hold
  plus `PAYMENT_GRACE_SECONDS` passes: the customer cannot cancel it (409) and cannot pay with a
  new key (409) meanwhile. Once stale, `PaymentReconciliationJob` queries `payments.lookup` (when
  the provider implements it) to either promote to `CHARGED` and settle/refund or release the
  claim; a real provider adapter without `lookup` still requires manual inspection if an unknown
  charge timed out before reaching `CHARGED`. Failed late refunds (`REFUND_PENDING`) and crashes
  between `CHARGED` and apply are retried automatically every 30 s.
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
- **The queue consumer takes one message at a time** (`receive(1)`, one loop per worker), so its
  throughput is one message per round trip and handler. Batching and parallel loops wait for a
  handler that is slow enough to need them. A message whose handler keeps failing is received
  `MAX_RECEIVE_COUNT` times (visibility timeout 120 s each) before it reaches the dead-letter
  queue.
- **A handler that runs longer than the 120 s visibility timeout** still sees its message delivered
  again while it works (the dedupe record serializes the two); the timeouts of the external calls
  keep a run well below that.
- **The mail effect costs one Keycloak call per message** (the address is read when the mail is
  sent, not stored). Acceptable at demo volume; a cache or a stored address needs a data-protection
  decision first.
- **The ticket font ships through an npm package** (`dejavu-fonts-ttf`, copied into the images with
  the dependencies) instead of a font file in the repository; replacing it means changing the
  renderer's font path.
- **Db specs assume no other consumer on the shared infrastructure.** A running Compose stack
  (worker, relay) on the same database and queue emulator made the mail-down consumer spec time
  out; under a full parallel run the queue consumer specs and `double books under naive` also
  failed once each and passed on a rerun. Give the specs their own database and queue names, or
  run them with the stack stopped.
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
- **The local development database holds test leftovers** (about 3,400 venues from earlier
  test runs). Reset it with
  `docker compose down -v`; the next `docker compose up` or `pnpm db:migrate` recreates it with the
  seed (this also resets the Keycloak realm, which lives in the same Postgres).
- **The worker restarts a blocked event loop only.** A watchdog thread (`watchdog.ts`) kills the
  process with SIGKILL when the main loop has not beaten for 30 s, so the restart policy brings it
  back. A worker whose loop runs but whose work is stuck (a hung consumer, a lost connection) is not
  restarted; `GaugeSourceMissing` and `OutboxStuck` show it. Compose has no healthcheck, because a
  restart policy does not react to an unhealthy container.
- **Stream slots of a vanished process expire only after the stream lifetime plus 60 s.** A slot
  is released when its stream ends; if the process dies, the address stays counted for up to eleven
  minutes. The caps are now shared (500 seat streams, 10 per address, 50 simulation streams for all
  replicas together).
- **The worker is a single instance.** Its jobs are safe in parallel (locks, consumer groups) but
  nothing runs more than one yet.
- **The pooler is one container on the path.** If it is down the apps are down; it has a
  health check and a restart policy, so it is back after a crash, but the apps fail meanwhile.
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

Phase 3, slice A:

- **Traces of a retry or redelivery are children of the same send span:** one trace, several
  consumer spans.
- **Root trace sampling defaults to 5 % in production** (`TRACING_SAMPLE_RATIO`, `1` locally and
  in Compose). Tail-based error/latency sampling at the collector is not configured yet.
- **Alloy mounts the Docker socket.** `:ro` does not limit the API
  ([observability.md](observability.md)).
- **Rows older than migration 0009 have no `traceparent`.**
- **The observability profile is not in CI,** so the trace check in
  [observability.md](observability.md) is by hand.
- **`pnpm dev` runs without tracing.**
- **A host `nest --watch` worker that shares the database and queue** relays outbox rows without
  tracing and breaks traces.
- **The Loki container has no health check** (distroless image with neither `/bin/sh` nor a
  self-check flag; Alloy retries its pushes until Loki is up).
- **`booking.hold.strategy` was not seen in Grafana by hand.**
- **The startup `SQS.GetQueueUrl` still produces traces.**
- **A simulation run emits about 7 spans per buyer attempt** (778 for 50 buyers). A 2000-buyer run
  may exceed Tempo's per-trace limit (not measured), and the trace link appears only in the
  finished-runs table.
- **A failed OTLP export drops spans silently.**
- **Test follow-ups:** the booking-trace spec asserts trace IDs, not the parent chain, and its
  e-mail check proves little because the effects are fakes; the consumer "no traceparent" test is
  a smoke test; the API and worker specs of the trace link were checked by mutation but not run red
  first.
- **Flaky database specs seen intermittently during the tracing work:**
  `tickets.controller.db.spec.ts` ("streams the stored PDF"), and two specs failed once with the
  observability stack running and passed with it down. They passed on rerun and in the final run;
  not investigated.

Phase 3, slice D:

- **A cross-instance reader can cache a stale value up to the TTL.** Within one API instance,
  `CacheAside.invalidate` marks in-flight loads stale so they skip `redis.set`; across separate
  API instances, a reader that loaded from PostgreSQL before another instance's commit can still
  write its value after invalidation until the TTL ends (30 s). Accepted; a version in the key
  would close it.
- **Seeds are not invalidated.** The seed writes events by SQL, so a changed seed shows up after the
  TTL.
- **A sandbox user pays one extra query.** The list of a signed-in user adds their own sandbox
  events from PostgreSQL to the cached public list; the detail of a sandbox event asks the cache
  first (a miss, never stored) and then PostgreSQL.
- **The `browse` scenario sets the ceiling of the load generator,** not of the system: it holds
  200 requests per second and both variants keep up, so it cannot show where the cache starts to
  matter. A scenario with a rising arrival rate would.
- **Load results are single runs on one machine** that also hosts the load generator; see the
  limits in [load-tests.md](load-tests.md).

Phase 3, slice B:

- **No alert delivery.** There is no Alertmanager; alerts show in the Prometheus UI only.
- **No burn-rate rules.** The 30-day availability budget is not computed; the 5 % short-window rule
  is its stand-in. Prometheus keeps 2 days.
- **`tm_db_queries_active` is in-flight queries, not pool usage,** and `tm_waiting_room_waiting` and
  `tm_db_queries_active` have no alert.
- **`tm_waiting_room_waiting` keeps a queue counted for up to 24 hours** after an event drops its
  waiting room.
- **A rate of a new counter shows no data until it has increased twice** (expired holds).
- **The observability profile is not in CI;** `promtool` was run by hand against the rule file and
  the config.
- **A host `pnpm dev` worker competes** with the container worker for the queue and the outbox, so
  its effects are not counted by the container worker's metrics.
- **`docker compose --profile observability stop` or `down` also stops the `pnpm db:up` containers**
  (same Compose project).

## Deliberately left out

- Kubernetes, microservices, Java/Spring, AI features, paid services (see
  [ADR 0001](adr/0001-modular-monolith-and-worker.md)).
