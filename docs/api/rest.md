# REST API

Contracts are the Zod schemas in `packages/shared`. Every route except the two probes sits under
the `/api` prefix (Caddy forwards `/api/*` and `/health/*` to the API).

The same routes are described for tools in [openapi.json](openapi.json) (OpenAPI 3.1): request and
response schemas come from `packages/shared`, the route table (method, path, roles, status codes) is
`apps/api/src/openapi/routes.ts`. `pnpm docs:generate` rewrites the file and `pnpm check` fails when
it is stale. `apps/api/src/openapi/openapi.spec.ts` compares the table with the Nest controllers
(routes, methods, `@Public` and `@Roles`, success status, the body, the `Idempotency-Key` header and
the id parameters), so a route that is added, removed or re-protected without the table fails the
test. Not covered by that comparison: the response schema (a TypeScript return type leaves no trace
at runtime) and the error statuses, which are written by hand from the services. Server-sent events
are a `text/event-stream` response whose `x-events` extension names the schema of each event.

| Method and path                    | Role      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`                 | public    | 200 `{ status: "UP" }`: the process serves requests                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /health/ready`                | public    | 200 `{ status: "UP", signals: { outbox } }` when Postgres (`select 1`), Redis (`PING`) and the outbox query answer; `outbox` is `ok`, or `stuck` when the oldest unpublished outbox row is older than 300 seconds (the worker or the queue is down), and `stuck` never changes the status. 503 `{ status: "DOWN" }` otherwise                                                                                                                                                                                                   |
| `GET /api/events`                  | public    | 200 `EventSummary[]` (`id`, `name`, `startsAt`, `venueName`, `strategy`): public events plus the caller's own sandbox events, ordered by `startsAt`                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/events/:id`              | public    | 200 `EventDetail` (summary plus `seats`: `id`, `section`, `row`, `number`, `priceCents`, `status`), 400 for a non-UUID id, 404 for an unknown event or another user's sandbox event                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/events/:id/seats/stream` | public    | Server-sent events (`text/event-stream`): first one `snapshot` (`SeatSnapshot`: every seat with its status), then one `change` (`SeatChange`) per seat change; a comment line `: heartbeat` every 15 s; 400 for a non-UUID id, 404 (as JSON, before the stream starts) for an unknown event or another user's sandbox event                                                                                                                                                                                                     |
| `POST /api/bookings`               | customer  | 201 `Booking` for a `HoldRequest` (`eventId`, `seatId`); 409 when the seat is taken, 404 when the seat is not in the event or the event is another user's sandbox, 400 for a malformed body                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/bookings/:id/payment`   | customer  | 200 `Booking` (`CONFIRMED`, or `CANCELLED` when the payment fails); header `Idempotency-Key` (a UUID) is required, else 400; 403 for another user's booking, 409 for an expired hold or a booking that cannot be paid                                                                                                                                                                                                                                                                                                           |
| `POST /api/bookings/:id/cancel`    | customer  | 200 `Booking` (`CANCELLED`) from `HELD` or `CONFIRMED`; 403 for another user's booking, 409 from any other status                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/bookings`                | customer  | 200 `Booking[]`: the caller's own bookings, newest first, each with its stored transitions newest first                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/venues`                  | organizer | 200 `Venue[]` (`id`, `name`, `seatCount`), ordered by name                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/events`                 | organizer | 201 `EventSummary` for a `CreateEventRequest` (`venueId`, `name`, `startsAt`, `strategy`): the event and a copy of the venue's seats with their prices are stored in one transaction; the owner is the caller from the token. A demo user's event is a sandbox event, private to that user. 404 for an unknown venue, 400 for a `startsAt` that is not in the future or a malformed body, 409 once the owner has 20 events (`MAX_EVENTS_PER_OWNER`; a demo user's four sandbox events count), 429 over the `CREATE_EVENT` limit |
| `GET /api/organizer/events`        | organizer | 200 `OrganizerEvent[]`: only events the caller owns, ordered by `startsAt`; `seatCount`, `soldCount` (seats with a `PAID` or `CONFIRMED` booking), `heldCount` (seats with a `HELD` booking) and `utilization` (`soldCount` / `seatCount`, 0 without seats) come from one SQL statement                                                                                                                                                                                                                                         |
| `PATCH /api/events/:id/strategy`   | admin     | 200 `EventSummary` for a `SetStrategyRequest` (`strategy`); a demo admin may switch only their own sandbox events, a regular admin only public events: any other event is 404, as is an unknown one; 400 for a non-UUID id or another strategy. Later holds use the new strategy; existing bookings keep the strategy they were made under                                                                                                                                                                                      |
| `POST /api/simulations`            | admin     | 201 `SimulationRun` (`QUEUED`) for a `StartSimulationRequest` (`strategy`; `buyers` and `seats` default to 500 and 100): a fresh sandbox event of the caller with that many seats, the run row and a command on the stream `simulations`. 400 for a body outside the limits, 429 while two runs are active (no `Retry-After`) or over the `SIMULATION` limit (with `Retry-After`)                                                                                                                                               |
| `GET /api/simulations`             | admin     | 200 `SimulationRun[]`: the 20 latest `FINISHED` runs, newest first; runs older than one hour are deleted, so these are the runs of the last hour                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/simulations/:id`         | public    | 200 `SimulationRun`, 400 for a non-UUID id, 404 for an unknown run; public because the run ID is a random UUID and the answer holds aggregate numbers only                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/simulations/:id/stream`  | public    | Server-sent events (`text/event-stream`): one `SimulationProgress` (`status`, `metrics`) at the start and again whenever it changes, completes after `FINISHED` or `FAILED`; 400 for a non-UUID id, 404 (as JSON, before the stream starts) for an unknown run, 503 above 50 open streams per process                                                                                                                                                                                                                           |
| `POST /api/demo-login`             | public    | 200 `TokenResponse` for a `DemoLoginRequest` (`role`: `customer`, `organizer` or `admin`), 400 for another role, 503 while 200 demo users exist (`MAX_DEMO_USERS`, nothing is created then) and also 503 when Keycloak does not answer within 5 s; creates a temporary user, rate limit `DEMO_LOGIN`                                                                                                                                                                                                                            |
| `POST /api/auth/refresh`           | public    | 200 `TokenResponse` (a new access and refresh token) for a `RefreshRequest` (`refreshToken`), 400 for a malformed body, 401 when Keycloak answers 400 `invalid_grant` (a bad refresh token), 503 when it fails (5xx) or does not answer within 5 s, 500 for any other answer, such as a wrong client secret; rate limit `REFRESH`                                                                                                                                                                                               |

A seat's `status` is derived in one query from its active booking (`HELD`, `PAID` or `CONFIRMED`
occupy the seat) and is `AVAILABLE` when there is none; it is never stored. A sandbox event is
private to its demo user: both routes show it only to a caller whose verified token carries that
user's `sub` (the events routes are public, but a token that is sent is read), and for anyone else
it does not exist.

## Live seat updates

Every stored change of a seat's derived status is published to the Redis channel `seats:<eventId>`
(JSON `SeatChange`: `eventId`, `seatId`, `status`, `at`) **after** the booking transaction has
committed: a hold (`HELD`), a payment (`SOLD`, or `AVAILABLE` when the charge failed and the booking
was cancelled, never the intermediate `PAID`), a cancellation, an expired hold and the cleanup of a
demo user's bookings on public events (`AVAILABLE`). A payment that only repeats its idempotency key
and a request that is refused with 409 change nothing and publish nothing. A failed publish is logged
with the booking (or demo user) ID and does not fail the request: the change is stored, and the
viewer's next snapshot has it. The seats of a demo user's own sandbox events are not published when
the user is cleaned up: nobody else could see them. The `status` is read from the database when the change is published (the furthest of the seat's
active bookings, the same rule as the event detail), not taken from the transition that caused it:
two changes that race cannot leave a stale status behind, and under the comparison strategy `NAIVE`,
where a seat can have several active bookings, a cancelled booking does not announce `AVAILABLE`
while another one still occupies the seat.

The stream route subscribes to the channel first and reads the snapshot afterwards, so a change that
commits in between is sent right after the snapshot instead of being lost; a change older than the
snapshot is harmless, the client applies changes in the order they arrive. All streams of a process
share one Redis subscriber connection, and an event is subscribed only while someone watches it. When
a client disconnects its stream is released; on shutdown every open stream is completed, so closing
the application does not wait for the clients. The route is public like the other events routes, and
a token that is sent unlocks the caller's own sandbox events; a browser `EventSource` cannot send an
`Authorization` header, so a client that needs a sandbox event reads the stream with `fetch`. The
rate limit counts the request that opens the stream, not its duration; open streams are capped
separately: at most 10 per client address (429) and 500 per process (503), counted in memory per
process. A stream ends on its own after 10 minutes, and every stream ends when the API's Redis
subscriber reconnects (changes published during the outage are lost); the client then reconnects and
receives a fresh snapshot, so a clean end of the stream is not an error.

Booking routes take the user from the verified token only; no route reads a user ID from the body,
query or path, and a booking of another user answers 403 without changing. The payment key is unique
over all bookings: the same key on the same booking returns the stored result without a second
charge, a key another booking already used answers 409.

The demo login creates a Keycloak user with a random name and password and the requested realm role,
stores it in `demo_users` with an expiry (`DEMO_USER_TTL_SECONDS`), gives it four private sandbox
events (one per booking strategy, on the hall's seats) and answers with the tokens of a password
grant on the server-only client `api-demo`; if a step fails, the Keycloak user is deleted again.
The worker deletes demo users in Keycloak once they have expired and their last access token has
expired too (`ACCESS_TOKEN_GRACE_SECONDS`, 300 s, the `accessTokenLifespan` of the realm: the guard is
stateless, so a deleted user's token would still book seats), then their bookings, sandbox events and row (see
[data model](../data-model.md)), once a minute, at most 100 users per run (`DEMO_CLEANUP_BATCH`, oldest first; a failing user is logged with its ID and error name and retried next run). The refresh route lets the browser renew its tokens
without talking to Keycloak. Details and the Keycloak facts behind them:
[ADR 0003](../adr/0003-authentication-and-demo-login.md).

Every response carries no personal data; requests are logged with the `x-request-id` of the caller
(or a generated one) and the `authorization` and `cookie` headers redacted.

## Headers, CORS and rate limits

- Every response carries the `helmet` defaults (for example `X-Content-Type-Options: nosniff`) and no
  `X-Powered-By`. The API trusts exactly one proxy hop (Caddy): the client address is the last
  `X-Forwarded-For` entry, so a prefix the client forges is ignored.
- Caddy (`apps/web/Caddyfile`) adds a Content-Security-Policy to every answer (`default-src 'self'`,
  scripts from the same origin only, no inline script, `frame-ancestors 'none'`; styles allow
  `'unsafe-inline'` because Angular writes component styles into `<style>` elements), plus
  `X-Content-Type-Options`, `Referrer-Policy: no-referrer` and `Permissions-Policy`. The web build
  keeps `inlineCritical` off: the inlined critical CSS comes with an inline script the policy blocks,
  which would leave the stylesheet unapplied.
- Caddy forwards `/api/*` with `flush_interval -1`, so the seat stream reaches the browser event by
  event instead of being held back; `encode` does not compress `text/event-stream`.
- CORS headers appear only when `CORS_ORIGIN` is set, and only for that origin (`GET`, `POST`,
  `PATCH`, `DELETE`; headers `Authorization` and `Content-Type`; no credentials). Behind Caddy web and
  API share an origin and the variable stays unset.
- Rate limits are fixed windows in Redis, checked by a global guard that runs after the auth guards.
  A request over the limit answers 429 `{ statusCode: 429, message: "Too Many Requests" }` with a
  `Retry-After` header (seconds). A request that fails authentication is not counted. Redis down
  means the guard fails and the request answers 500. The client address is counted per IPv4
  address (also an IPv4-mapped IPv6 one) and per IPv6 `/64` prefix, so a client cannot dodge a limit
  by changing the low 64 bits of its address.

| Limit          | Applies to                                                    | Counted per                                   | Allowed per window |
| -------------- | ------------------------------------------------------------- | --------------------------------------------- | ------------------ |
| `DEFAULT`      | every route without `@RateLimit`; also every signed-in caller | client address; and user (`sub`) if signed in | 120 per 60 s       |
| `DEMO_LOGIN`   | the demo login (replaces `DEFAULT` for the address)           | client address                                | 5 per 60 s         |
| `REFRESH`      | the token refresh (replaces `DEFAULT` for the address)        | client address                                | 30 per 60 s        |
| `CREATE_EVENT` | `POST /api/events` (replaces `DEFAULT` for the address)       | client address                                | 10 per 60 s        |

## Payment idempotency

The payment `Idempotency-Key` is a UUID that the client generates randomly for each payment attempt
and sends again only to repeat that same attempt (retry after a timeout). The same key on the same
booking returns the first answer without a second charge. The stored key is unique over all
bookings of all users, so a predictable key (`1`, an order number) of one user would make another
user's payment fail with 409 and reveal that the key exists. A random UUID cannot be guessed, which
is why any other format answers 400.

The charge runs in three steps, none of which holds a database lock while the provider answers:
the request locks the booking, refuses what cannot be paid and stores the key (committed); the
provider is called with the key; the request locks the booking again and stores the result
(`PAID` then `CONFIRMED`, or `CANCELLED`); a confirmation also writes the `BOOKING_CONFIRMED` outbox
row in that transaction (a failed payment writes nothing). A request that dies after the first step leaves the key
claimed on a `HELD` booking. Repeating the request with the same key repeats the charge, which the
provider answers alike for the same key, and finishes the booking. Another key on a booking whose
key is claimed, and a payment that finishes after the booking left `HELD` (cancelled or expired
meanwhile), answer 409; the second case stores nothing. The provider is not refunded in that case
(see the backlog). The expiry job leaves a `HELD` booking with a claimed key alone until its hold
is 120 seconds past (`PAYMENT_GRACE_SECONDS`), so a charge that started in time can finish.

## Dictionaries

`packages/shared` holds the values every contract uses, each as an `as const` dictionary with a Zod
enum and an inferred type.

| Dictionary          | Values                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `BOOKING_STRATEGY`  | `NAIVE`, `PESSIMISTIC`, `OPTIMISTIC`, `REDIS_LOCK`                                              |
| `BOOKING_STATUS`    | `HELD`, `PAID`, `CONFIRMED`, `EXPIRED`, `CANCELLED`                                             |
| `SEAT_STATUS`       | `AVAILABLE`, `HELD`, `SOLD` (derived from the bookings of a seat)                               |
| `TRANSITION_REASON` | `HOLD`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `CONFIRMED`, `HOLD_EXPIRED`, `CANCELLED_BY_USER` |
| `SIMULATION_STATUS` | `QUEUED`, `RUNNING`, `FINISHED`, `FAILED` (status of a simulation run)                          |

## Auth, booking and organizer contracts

The schemas below are in `packages/shared`; the routes that use them are in the table above.
Authentication is described in [ADR 0003](../adr/0003-authentication-and-demo-login.md).

| Schema                                                                                  | Purpose                                                                                                   |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `RoleSchema` (`ROLE`)                                                                   | Realm roles: `customer`, `organizer`, `admin`                                                             |
| `DemoLoginRequestSchema`, `RefreshRequestSchema`                                        | `{ role }` for the demo login, `{ refreshToken }` for the token refresh                                   |
| `TokenResponseSchema`                                                                   | `{ accessToken, refreshToken, expiresIn }`                                                                |
| `AccessTokenClaimsSchema`                                                               | `realm_access.roles` of an access token; the web app reads it to show the role, never to decide           |
| `HoldRequestSchema`, `IdempotencyKeySchema`                                             | `{ eventId, seatId }`; the `Idempotency-Key` header value (a UUID)                                        |
| `BookingSchema`, `BookingListResponseSchema`                                            | A booking with its seat position and stored transitions (`fromStatus`, `toStatus`, `reason`, `at`)        |
| `VenueSchema`, `CreateEventRequestSchema`, `SetStrategyRequestSchema`                   | Venue templates with `seatCount`; create an event; switch the strategy                                    |
| `OrganizerEventSchema`                                                                  | An event summary with `seatCount`, `soldCount`, `heldCount` and `utilization` (0..1)                      |
| `SeatChangeSchema`, `SeatSnapshotSchema` and `SEAT_STREAM_EVENT` (`snapshot`, `change`) | One seat's new derived status; the `{ seats }` of the first event; the two event names of the seat stream |

## Simulation contracts

The rush simulator runs virtual buyers against a fresh sandbox event under one booking strategy.
The schemas are in `packages/shared`; the routes are in the table above and described below.

| Schema                                                                          | Purpose                                                                                                                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StartSimulationRequestSchema`                                                  | `{ buyers, seats, strategy }`; `buyers` 1 to 2000 (default 500), `seats` 1 to 500 (default 100), limits in `SIMULATION_LIMITS`                                 |
| `SimulationMetricsSchema`                                                       | Counters (`attempts`, `holds`, `conflicts`, `constraintViolations`, `retries`, `buyersDone`), `p50Ms`, `p95Ms`, and `doubleBookings` (null until the run ends) |
| `SimulationProgressSchema`                                                      | `{ status, metrics }`, the payload of the live progress                                                                                                        |
| `SimulationRunSchema`, `SimulationListResponseSchema`                           | A run with its event, strategy, size, status, final metrics (null until finished) and ISO timestamps                                                           |
| `SimulationCommandSchema`, `SIMULATION_STREAM_KEY`, `SIMULATION_CONSUMER_GROUP` | The queue message `{ runId }` on the Redis stream `simulations` and the consumer group that reads it; the worker takes the parameters from the run row         |

`doubleBookings` always comes from the database (active bookings per seat minus one), never from the
runner's counters. A buyer retries by picking another seat, so `retries` counts attempts beyond a
buyer's first.

## Simulation runs

`POST /api/simulations` runs in one transaction under a PostgreSQL advisory lock: it counts the runs
that are `QUEUED` or `RUNNING` and started within the last 10 minutes (`SIMULATION_RUN_TIMEOUT_MS`);
at two (`MAX_ACTIVE_RUNS`) it answers 429 and writes nothing, so parallel requests cannot beat the
cap. The count comes from the rows, not from a counter: the window frees the slot of a run whose
worker died. Otherwise the transaction creates the event (owner and `sandbox_user_id` are the admin
from the token, so it never shows in the public event list), its seats in one `generate_series`
statement and the run. After the commit the key `simulation:<runId>:progress` is written with `QUEUED` and empty metrics
and the command `{ runId }` goes onto the Redis stream `simulations`; when either write fails the sandbox event is deleted (its seats and the run cascade) and the
error is returned, so a failed start leaves nothing behind.

The progress stream polls the key `simulation:<runId>:progress` every 250 ms (the worker writes it
with a one-hour expiry) and sends a message only when the value changed; it needs no subscriber
connection, so there is no race between a snapshot and a subscription and it works across API
instances. The key exists from the start of the run, so a queued run costs no database read; only
while it is absent (it has expired, or Redis lost it) the stream reports the row on every poll. A value in the key that is not a `SimulationProgress` ends the stream with an
error; no fallback data is sent. A stream ends on its own after 10 minutes, and a client can read
the run with `GET /api/simulations/:id` at any time. The cap of open streams (50) is counted in
memory per process.

The worker reads the stream through the consumer group `simulation-workers` (created on start, from
the beginning of the stream, so a command written before the group existed is read; one run at a time per worker, a blocking read on a connection of its own).
The idempotency key of the command is the run ID: the worker starts a run only by changing its row
from `QUEUED` to `RUNNING`, so a command that is delivered twice runs once; a malformed command, an
unknown run and a repeated command are logged with their IDs and acknowledged. The worker reads the
parameters from the row, writes the progress key every 250 ms, counts the double bookings in SQL
when the buyers are done and stores the final metrics. A run that fails is stored as `FAILED` (with
its last progress in the key) and acknowledged; the next command still runs. A command whose
handling fails on the infrastructure (database or Redis down) stays pending.
Every buyer books as the admin who started the run,
because a sandbox event accepts bookings only from its owner.

The worker's reaper job (every 30 seconds) recovers what a dead worker leaves behind. A run that is
still `QUEUED` or `RUNNING` although it started more than `SIMULATION_RUN_TIMEOUT_MS` ago becomes
`FAILED` with its end time, and its progress key is set to `FAILED` with empty metrics, so open
streams end; the cut is the exact complement of the cap's window. A queue entry that was delivered
to a worker and not acknowledged for that long is acknowledged. A run that is still going after the
timeout is failed too; if its worker then stores a result, the worker drops it (logging the run ID),
so the run stays `FAILED`, as the open streams showed.

The worker's retention job (every minute, up to 100 events per tick) deletes the sandbox event of
every run that is `FINISHED` or `FAILED` for more than `SIMULATION_RETENTION_SECONDS` (one hour):
the seats, the bookings with their transitions and the run go with it (foreign keys cascade). An
event that still has a `QUEUED` or `RUNNING` run is never deleted. The comparison list therefore
shows the runs of the last hour.

## Queue and bucket names

The names and the redrive policy of the queues and the bucket are dictionaries in
`packages/shared/src/aws.ts`, so the API, the worker and the creation script read the same values.
`QUEUE_NAME` holds `booking-events` and its dead-letter queue `booking-events-dlq`; `QUEUE_POLICY`
holds `MAX_RECEIVE_COUNT` (5: a message that was received five times without being deleted moves to
the dead-letter queue), `VISIBILITY_TIMEOUT_SECONDS` (30) and `LONG_POLL_SECONDS` (20);
`BUCKET_NAME` holds `tickets`.

## Queue messages

Every message on `booking-events` is one `QueueMessageSchema` (`packages/shared/src/outbox.ts`), a
union told apart by `type` (`OUTBOX_MESSAGE_TYPE`). Today there is one: `BOOKING_CONFIRMED` with
`messageId`, `bookingId`, `eventId`, `userId` (UUIDs) and `occurredAt` (ISO timestamp). A message
carries IDs only, never a name or an email address.

Delivery is at least once. `messageId` is the ID of the outbox row (`outbox_messages.id`), is sent
as the message attribute `messageId` and is the idempotency key of every consumer: a consumer
records `(consumer, messageId)` in `processed_messages` in the transaction of its effect and
handles a message ID once. A message that does not parse is not deleted; it ends in the dead-letter
queue after `QUEUE_POLICY.MAX_RECEIVE_COUNT` receives.
