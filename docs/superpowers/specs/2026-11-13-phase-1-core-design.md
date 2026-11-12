# Phase 1: Core, design

Scope and Definition of Done come from [PLAN.md](../../PLAN.md#phase-1-core); this document fixes
the design decisions. Rules: [AGENTS.md](../../../AGENTS.md).

## Outcome

The booking core runs locally with `docker compose up --build`: one-click demo login for customer,
organizer and admin, seat holds with expiry and fake payment under four switchable strategies, live
seat maps over SSE, and a rush simulator whose dashboard shows double bookings above zero only for
`naive`.

Out of scope for phase 1: outbox, SQS, email, ticket PDF, waiting room, several API instances
behind Caddy, PgBouncer (phase 2); OpenTelemetry, Grafana, trace links in the simulator dashboard,
audit log view, caching (phase 3); regular registration and PKCE login (backlog, the Definition of
Done needs only demo login); simulator queue with a visible position (phase 5).

## Decisions

| Topic          | Decision                                                                                                                                          | Rejected                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Work split     | One spec, one plan per slice (A to D), stop and report after each slice                                                                           | One plan for the whole phase; a full spec cycle per slice |
| Simulator      | Runs in the worker; the API enqueues a command on a Redis stream                                                                                  | In the API process (load and state in the API)            |
| Keycloak setup | Realm import JSON (`--import-realm`); demo users created at runtime through the Admin API                                                         | Idempotent setup script against the Admin API             |
| Local secrets  | Config defaults for the local Compose values outside production; optional `.env` through Node's `--env-file-if-exists`; Compose sets env directly | Compose env only                                          |
| Seat state     | Derived from bookings; `seats.version` exists only for the optimistic strategy                                                                    | A status column on seats (two sources of truth)           |
| Demo isolation | `events.sandbox_user_id`: null means public, otherwise only that user sees the event                                                              | Separate schema or database per demo user                 |
| Demo login     | API creates the Keycloak user and gets tokens by password grant on a confidential client that only the API knows                                  | Token exchange, impersonation (more Keycloak setup)       |
| Simulator SSE  | Public by run ID; the stream carries only aggregate metrics, no user data                                                                         | Stream tickets or fetch-based SSE with a bearer token     |

ADRs written in the slice that needs them: 0002 booking strategies and the database constraint
(slice A), 0003 authentication and demo login (slice B).

## Slice A: data model, booking strategies, hold expiry

**Infrastructure in the API:** Drizzle with `postgres` driver, Redis client, pino with request ID
(`x-request-id` taken or generated, `authorization` redacted), global `/api` prefix (Caddy forwards
`/api/*`), `GET /health/ready` (Postgres and Redis ping). Config gains `DATABASE_URL`, `REDIS_URL`,
`HOLD_TTL_SECONDS`, `PAYMENT_FAILURE_RATE`, `CORS_ORIGIN`; defaults only when `NODE_ENV` is not
`production`, otherwise missing values fail the start.

**Tables** (drizzle-kit migrations, documented in `docs/data-model.md` with ERD and state machine):

- `venues` (id, name) and `venue_seats` (venue_id, section, row, number): seat templates.
- `events` (id, venue_id, name, starts_at, strategy, owner_id, sandbox_user_id null, created_at).
- `seats` (id, event_id, section, row, number, price_cents, version): copied from the template
  when an event is created.
- `bookings` (id, event_id, seat_id, user_id, strategy, status, hold_expires_at,
  payment_idempotency_key unique null, created_at, updated_at).
- `booking_transitions` (id, booking_id, from_status null, to_status, reason, actor_id, at).
- Partial unique index on `bookings(seat_id)` where status is active (HELD, PAID, CONFIRMED) and
  strategy is not NAIVE: defense in depth (ADR 0002). `strategy` is copied onto the booking so the
  index can exclude the comparison mode.

Seed: two venues, a handful of public events.

**Dictionaries in `packages/shared`:** `BOOKING_STRATEGY` (NAIVE, PESSIMISTIC, OPTIMISTIC,
REDIS_LOCK), `BOOKING_STATUS` (HELD, PAID, CONFIRMED, EXPIRED, CANCELLED), `SEAT_STATUS`
(AVAILABLE, HELD, SOLD), `TRANSITION_REASON` (HOLD, PAYMENT_SUCCEEDED, PAYMENT_FAILED, CONFIRMED,
HOLD_EXPIRED, CANCELLED_BY_USER).

**State machine** (pure, in the bookings domain): HELD → PAID → CONFIRMED; HELD → EXPIRED;
HELD → CANCELLED (payment failed or user); CONFIRMED → CANCELLED (user). Every other transition is
an error. Each transition returns the new state plus the transition record; the adapter stores
both in one transaction.

```ts
// Signature fixed here, body written in the plan's TDD step.
function transition(booking: BookingState, command: BookingCommand, now: Date): TransitionResult;
```

**Strategies:** port `SeatReservation` with `hold(input: HoldInput): Promise<HoldResult>`, result
either the booking or a conflict. Adapters:

- `naive`: read active bookings of the seat, insert if none. No lock.
- `pessimistic`: transaction, `SELECT … FROM seats WHERE id = $1 FOR UPDATE`, check, insert.
- `optimistic`: read `seats.version`, check, insert, `UPDATE seats SET version = version + 1 WHERE
id = $1 AND version = $read`; zero rows rolls back and reports a conflict (with bounded retries).
- `redis-lock`: `SET lock:seat:<id> <token> NX PX <ms>`, check and insert, release by
  compare-and-delete with the token.

The event's `strategy` selects the adapter. A unique-index violation is reported as its own
outcome, so tests can tell a strategy that prevented the double booking from one that relied on the
index.

**Hold expiry:** worker job on a fixed interval: select HELD bookings with `hold_expires_at <
now` (`FOR UPDATE SKIP LOCKED`), apply the domain transition, store it. The worker joins the
Compose stack with its Dockerfile target. Time from the injected `Clock`.

**Payment** (HTTP in slice B, service here): port `PaymentProvider` with an adjustable failure
rate (`PAYMENT_FAILURE_RATE`). Success: HELD → PAID → CONFIRMED in one transaction. Failure:
HELD → CANCELLED with reason PAYMENT_FAILED. The idempotency key is stored on the booking; the
same key returns the stored result, another key on a booking that is no longer HELD answers 409.

**Read endpoints (public):** `GET /api/events` (public plus own sandbox events), `GET
/api/events/:id` with seats and derived seat status. Web: event list and seat map, read-only, with
the four UI states; `DESIGN.md` with the first tokens.

**Tests:** domain unit tests for every transition and every forbidden one; `test:db` script and CI
job (Postgres and Redis as services) for the adapters; the concurrency test per strategy (many
parallel holds on one seat over separate connections) asserting double bookings above zero for
`naive` and zero for the others, and zero index violations for the others; expiry job test with a
fake clock.

## Slice B: authentication, demo login, booking flow, basic security

**Keycloak:** realm JSON in `docker/keycloak/` with realm roles `customer`, `organizer`, `admin`;
client `web` (public, used later for PKCE); client `api-demo` (confidential, direct access grants,
service account with `manage-users`). Compose mounts it with `--import-realm`.

**Demo login:** `POST /api/demo-login` with `{ role }`: create a Keycloak user with a random
password and the role, store `demo_users` (user_id, role, expires_at), seed one sandbox event per
strategy for that user, get tokens by password grant, return access and refresh token. Rate limited
strictly. Worker job deletes expired demo users in Keycloak and their sandbox data.

**API auth:** guard verifies the bearer token against the realm JWKS (`jose`), reads `sub` and
realm roles; `@Roles()` decorator plus roles guard. Ownership filters in every query on bookings and
organizer events. Each protected route's spec tests wrong role and foreign resource with 403.

**Endpoints:**

| Method and path                  | Role      | Purpose                                |
| -------------------------------- | --------- | -------------------------------------- |
| `POST /api/bookings`             | customer  | hold a seat `{ eventId, seatId }`      |
| `POST /api/bookings/:id/payment` | customer  | pay, header `Idempotency-Key` required |
| `POST /api/bookings/:id/cancel`  | customer  | cancel own HELD or CONFIRMED booking   |
| `GET /api/bookings`              | customer  | own bookings with transitions          |
| `GET /api/venues`                | organizer | venue templates                        |
| `POST /api/events`               | organizer | create an event from a venue           |
| `GET /api/organizer/events`      | organizer | own events with sales and utilization  |
| `PATCH /api/events/:id/strategy` | admin     | switch the strategy                    |

**Security:** Helmet, CORS limited to `CORS_ORIGIN`, CSP in the web Caddyfile, Zod pipe for every
input, rate limits in Redis per IP and per user (default, demo login, simulator stricter), global
exception filter mapping domain errors to status codes without leaking internals.

**Web:** start page with three demo-login buttons; token held in a signal and `sessionStorage`,
HTTP interceptor adds the bearer token and refreshes on 401; hold, pay and cancel on the seat map;
my bookings; organizer screens; admin strategy switch.

**Tests:** guard and auth tests per route, demo-login service with MSW for Keycloak, Playwright:
demo login, hold, pay, confirmation.

## Slice C: live seat map

Every stored booking transition publishes `{ eventId, seatId, status: SEAT_STATUS, at }` to the
Redis channel `seats:<eventId>` after commit. `GET /api/events/:id/seats/stream` (SSE, public):
subscribe to Redis first, then send a snapshot event, then the deltas, so no change is lost between
snapshot and subscription. One Redis subscriber connection per API process, fanned out to clients
with RxJS. The web seat map consumes the stream as an Observable and reconnects. Playwright: a hold
in tab A marks the seat as taken in tab B within one second.

## Slice D: rush simulator

`POST /api/simulations` (admin, `{ eventId?, buyers ≤ 2000, seats ≤ 500, strategy }`, defaults 500
and 100): create a fresh sandbox event with M seats for the admin, store `simulation_runs` (id,
event_id, strategy, buyers, seats, status, metrics, started_by, started_at, finished_at), append
the command to the Redis stream `simulations`. At most two runs at a time (Redis counter), else 429.

Worker consumes the stream with a consumer group, runs N virtual buyers with bounded concurrency
against the bookings module (synthetic user IDs, no HTTP), retries conflicts a bounded number of
times, publishes metrics every 250 ms to `simulation:<id>`: attempts, holds, conflicts, retries,
p50 and p95 latency. At the end it counts double bookings in SQL (seats with more than one active
booking) and stores the final metrics. `GET /api/simulations/:id` and
`GET /api/simulations/:id/stream` (SSE) serve the dashboard.

Web: admin dashboard with the start form, live counters and a per-strategy comparison of finished
runs. Test: a simulator run per strategy with small numbers asserts double bookings above zero for
`naive` and zero for the others.

## Execution

Each slice gets its own plan under `docs/superpowers/plans/`, executed with `umsetzer` subagents;
review only for state, concurrency and auth tasks, one final review per slice. Docs change with the
code (README sections for requirements, entities, API and a preliminary architecture diagram,
`docs/data-model.md`, docs-map entries for the schema and new modules). After each slice: stop,
report, update [BACKLOG.md](../../BACKLOG.md).

## Risks

- `naive` might not race reliably in tests. Mitigation: many parallel holds on one seat with a
  connection pool as large as the parallelism; if still flaky, the plan decides on a deterministic
  trigger.
- The password grant is deprecated in OAuth 2.1. Accepted for demo users only, on a client the
  browser never sees; ADR 0003 records it.
- Keycloak memory on developer machines; already part of the stack since phase 0.
