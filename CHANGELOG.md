# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the versions follow [SemVer](https://semver.org/). The state of the work and the open points are in
[docs/BACKLOG.md](docs/BACKLOG.md).

## [Unreleased]

### Added

- Payments: release a claimed payment key when the provider throws `PaymentNotChargedError`, and
  automatically refund charges that succeeded after a booking expired (`PAYMENT_REFUNDED` audit
  row).
- Tickets & demo cleanup: serialize ticket PDF/mail effects against cancellation with a share
  lock, purge stored PDFs of cancelled bookings and expired demo users, move poison queue messages
  directly to the dead-letter queue, and replay dead-letter queue messages via `pnpm dlq:replay`.
- Audit log UI: filter entries by actor ID.
- Waiting room UI: configure or disable `waitingRoomCapacity` on existing events from the seat map
  for organizers and admins (`WaitingRoomSettings`).
- Docs generator: report defaulted env fields wrapped in `.transform(...)` with their default
  value (`TRACING_OTLP_ENDPOINT`).
- Infrastructure: declare explicit `MessageRetentionPeriod` (4 days) on `BOOKING_EVENTS` and its
  dead-letter queue in `INFRASTRUCTURE`.

### Changed

- Event cache: short-circuit Redis lookups for 5 s after five consecutive failures and admit a
  single probe call on half-open recovery.
- Waiting room stream: emit 15 s SSE heartbeats on the API and reconnect from the web client after
  three missed beats (45 s idle).
- Telemetry: flush tracing and metrics via Nest's `OnApplicationShutdown` lifecycle instead of
  racing graceful shutdown on `SIGTERM`.
- Web app: lazy-load non-root routes to reduce the initial bundle (844 kB -> 756 kB) and configure
  Zod `jitless: true` so Chrome raises no CSP `eval` warning.

## [0.1.0]

First release: the system runs locally with `docker compose up`. The public live demo is not part
of it (phase 5).

### Added

- Booking core: seat map, hold, pay and cancel with idempotency keys, a state machine that stores
  every transition, and four hold strategies (`naive`, optimistic, pessimistic, Redis lock). The
  concurrency test counts double bookings per strategy: above zero for `naive`, zero for the rest.
- Identity: Keycloak with the roles `customer`, `organizer` and `admin`, access tokens verified by
  a default-deny guard, a one-click demo login with temporary users, rate limits, security headers
  and a Content-Security-Policy.
- Live seat map over server-sent events, an organizer area, the admin strategy switch and the rush
  simulator with a comparison table of runs.
- Asynchronous work: transactional outbox, queue with a dead-letter queue, idempotent consumers,
  ticket PDF and confirmation mail, a virtual waiting room, two API replicas behind Caddy and
  PgBouncer. The queues and the bucket are declared in code.
- Observability: OpenTelemetry traces with correlated logs, metrics, four Grafana dashboards, nine
  alert rules with SLOs, an audit log with an admin page, k6 load scenarios and a cache of the
  public event list.
- Hardening: row-level security on bookings, container limits and dropped capabilities, a STRIDE
  threat model, a security policy with private vulnerability reporting, and mutation tests of the
  domain code (weekly in CI).
- A light web portal in Angular with four UI states on every async view.
- A demo GIF at the top of the README and a module graph generated from the code
  ([docs/architecture.md](docs/architecture.md)).
- Runbooks for the dead-letter queue, a stuck outbox and a service that is down.
- Quality gates: typecheck, ESLint, dependency-cruiser layers, dead-code and duplication checks,
  magic-string and docs audits, unit, database and end-to-end tests, CI with Trivy, Semgrep and
  gitleaks.

### Known limits

See [Open points](docs/BACKLOG.md#open-points); among them: a payment that throws after its claim
leaves the booking `HELD` until the hold runs out, a late successful charge is not refunded, and
published outbox rows and ticket PDFs are never deleted.

[Unreleased]: https://github.com/oguzbits/ticketmaster/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/oguzbits/ticketmaster/releases/tag/v0.1.0
