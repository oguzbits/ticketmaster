# REST API

Contracts are the Zod schemas in `packages/shared`. Every route except the two probes sits under
the `/api` prefix (Caddy forwards `/api/*` and `/health/*` to the API).

| Method and path                    | Role      | Answer                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`                 | public    | 200 `{ status: "UP" }`: the process serves requests                                                                                                                                                                                                                                                                                                                                      |
| `GET /health/ready`                | public    | 200 `{ status: "UP" }` when Postgres (`select 1`) and Redis (`PING`) answer, 503 `{ status: "DOWN" }` otherwise                                                                                                                                                                                                                                                                          |
| `GET /api/events`                  | public    | 200 `EventSummary[]` (`id`, `name`, `startsAt`, `venueName`, `strategy`): public events plus the caller's own sandbox events, ordered by `startsAt`                                                                                                                                                                                                                                      |
| `GET /api/events/:id`              | public    | 200 `EventDetail` (summary plus `seats`: `id`, `section`, `row`, `number`, `priceCents`, `status`), 400 for a non-UUID id, 404 for an unknown event or another user's sandbox event                                                                                                                                                                                                      |
| `GET /api/events/:id/seats/stream` | public    | Server-sent events (`text/event-stream`): first one `snapshot` (`SeatSnapshot`: every seat with its status), then one `change` (`SeatChange`) per seat change; a comment line `: heartbeat` every 15 s; 400 for a non-UUID id, 404 (as JSON, before the stream starts) for an unknown event or another user's sandbox event                                                              |
| `POST /api/bookings`               | customer  | 201 `Booking` for a `HoldRequest` (`eventId`, `seatId`); 409 when the seat is taken, 404 when the seat is not in the event or the event is another user's sandbox, 400 for a malformed body                                                                                                                                                                                              |
| `POST /api/bookings/:id/payment`   | customer  | 200 `Booking` (`CONFIRMED`, or `CANCELLED` when the payment fails); header `Idempotency-Key` (a UUID) is required, else 400; 403 for another user's booking, 409 for an expired hold or a booking that cannot be paid                                                                                                                                                                    |
| `POST /api/bookings/:id/cancel`    | customer  | 200 `Booking` (`CANCELLED`) from `HELD` or `CONFIRMED`; 403 for another user's booking, 409 from any other status                                                                                                                                                                                                                                                                        |
| `GET /api/bookings`                | customer  | 200 `Booking[]`: the caller's own bookings, newest first, each with its stored transitions newest first                                                                                                                                                                                                                                                                                  |
| `GET /api/venues`                  | organizer | 200 `Venue[]` (`id`, `name`, `seatCount`), ordered by name                                                                                                                                                                                                                                                                                                                               |
| `POST /api/events`                 | organizer | 201 `EventSummary` for a `CreateEventRequest` (`venueId`, `name`, `startsAt`, `strategy`): the event and a copy of the venue's seats with their prices are stored in one transaction; the owner is the caller from the token. A demo user's event is a sandbox event, private to that user. 404 for an unknown venue, 400 for a `startsAt` that is not in the future or a malformed body |
| `GET /api/organizer/events`        | organizer | 200 `OrganizerEvent[]`: only events the caller owns, ordered by `startsAt`; `seatCount`, `soldCount` (seats with a `PAID` or `CONFIRMED` booking), `heldCount` (seats with a `HELD` booking) and `utilization` (`soldCount` / `seatCount`, 0 without seats) come from one SQL statement                                                                                                  |
| `PATCH /api/events/:id/strategy`   | admin     | 200 `EventSummary` for a `SetStrategyRequest` (`strategy`); 404 for an unknown event, 400 for a non-UUID id or another strategy. Later holds use the new strategy; existing bookings keep the strategy they were made under                                                                                                                                                              |
| `POST /api/demo-login`             | public    | 200 `TokenResponse` for a `DemoLoginRequest` (`role`: `customer`, `organizer` or `admin`), 400 for another role, 503 while 200 demo users exist (`MAX_DEMO_USERS`, nothing is created then) and also 503 when Keycloak does not answer within 5 s; creates a temporary user, rate limit `DEMO_LOGIN`                                                                                     |
| `POST /api/auth/refresh`           | public    | 200 `TokenResponse` (a new access and refresh token) for a `RefreshRequest` (`refreshToken`), 400 for a malformed body, 401 when Keycloak answers 400 `invalid_grant` (a bad refresh token), 503 when it fails (5xx) or does not answer within 5 s, 500 for any other answer, such as a wrong client secret; rate limit `REFRESH`                                                        |

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
the user is cleaned up: nobody else could see them. Under the comparison strategy `NAIVE`, where a seat
can have several active bookings, the message carries the status of the booking that changed, so it
can say `AVAILABLE` while another booking still occupies the seat; the next snapshot corrects it.

The stream route subscribes to the channel first and reads the snapshot afterwards, so a change that
commits in between is sent right after the snapshot instead of being lost; a change older than the
snapshot is harmless, the client applies changes in the order they arrive. All streams of a process
share one Redis subscriber connection, and an event is subscribed only while someone watches it. When
a client disconnects its stream is released; on shutdown every open stream is completed, so closing
the application does not wait for the clients. The route is public like the other events routes, and
a token that is sent unlocks the caller's own sandbox events; a browser `EventSource` cannot send an
`Authorization` header, so a client that needs a sandbox event reads the stream with `fetch`. The
rate limit counts the request that opens the stream, not its duration.

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
- CORS headers appear only when `CORS_ORIGIN` is set, and only for that origin (`GET`, `POST`,
  `PATCH`, `DELETE`; headers `Authorization` and `Content-Type`; no credentials). Behind Caddy web and
  API share an origin and the variable stays unset.
- Rate limits are fixed windows in Redis, checked by a global guard that runs after the auth guards.
  A request over the limit answers 429 `{ statusCode: 429, message: "Too Many Requests" }` with a
  `Retry-After` header (seconds). A request that fails authentication is not counted. Redis down
  means the guard fails and the request answers 500. The client address is counted per IPv4
  address (also an IPv4-mapped IPv6 one) and per IPv6 `/64` prefix, so a client cannot dodge a limit
  by changing the low 64 bits of its address.

| Limit        | Applies to                                                    | Counted per                                   | Allowed per window |
| ------------ | ------------------------------------------------------------- | --------------------------------------------- | ------------------ |
| `DEFAULT`    | every route without `@RateLimit`; also every signed-in caller | client address; and user (`sub`) if signed in | 120 per 60 s       |
| `DEMO_LOGIN` | the demo login (replaces `DEFAULT` for the address)           | client address                                | 5 per 60 s         |
| `REFRESH`    | the token refresh (replaces `DEFAULT` for the address)        | client address                                | 30 per 60 s        |

## Payment idempotency

The payment `Idempotency-Key` is a UUID that the client generates randomly for each payment attempt
and sends again only to repeat that same attempt (retry after a timeout). The same key on the same
booking returns the first answer without a second charge. The stored key is unique over all
bookings of all users, so a predictable key (`1`, an order number) of one user would make another
user's payment fail with 409 and reveal that the key exists. A random UUID cannot be guessed, which
is why any other format answers 400.

## Dictionaries

`packages/shared` holds the values every contract uses, each as an `as const` dictionary with a Zod
enum and an inferred type.

| Dictionary          | Values                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `BOOKING_STRATEGY`  | `NAIVE`, `PESSIMISTIC`, `OPTIMISTIC`, `REDIS_LOCK`                                              |
| `BOOKING_STATUS`    | `HELD`, `PAID`, `CONFIRMED`, `EXPIRED`, `CANCELLED`                                             |
| `SEAT_STATUS`       | `AVAILABLE`, `HELD`, `SOLD` (derived from the bookings of a seat)                               |
| `TRANSITION_REASON` | `HOLD`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `CONFIRMED`, `HOLD_EXPIRED`, `CANCELLED_BY_USER` |

## Auth, booking and organizer contracts

The schemas below are defined in `packages/shared` ahead of their routes; each route is documented
in the table above when it is implemented. Authentication is described in
[ADR 0003](../adr/0003-authentication-and-demo-login.md).

| Schema                                                                                  | Purpose                                                                                                   |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `RoleSchema` (`ROLE`)                                                                   | Realm roles: `customer`, `organizer`, `admin`                                                             |
| `DemoLoginRequestSchema`, `RefreshRequestSchema`                                        | `{ role }` for the demo login, `{ refreshToken }` for the token refresh                                   |
| `TokenResponseSchema`                                                                   | `{ accessToken, refreshToken, expiresIn }`                                                                |
| `HoldRequestSchema`, `IdempotencyKeySchema`                                             | `{ eventId, seatId }`; the `Idempotency-Key` header value (a UUID)                                        |
| `BookingSchema`, `BookingListResponseSchema`                                            | A booking with its seat position and stored transitions (`fromStatus`, `toStatus`, `reason`, `at`)        |
| `VenueSchema`, `CreateEventRequestSchema`, `SetStrategyRequestSchema`                   | Venue templates with `seatCount`; create an event; switch the strategy                                    |
| `OrganizerEventSchema`                                                                  | An event summary with `seatCount`, `soldCount`, `heldCount` and `utilization` (0..1)                      |
| `SeatChangeSchema`, `SeatSnapshotSchema` and `SEAT_STREAM_EVENT` (`snapshot`, `change`) | One seat's new derived status; the `{ seats }` of the first event; the two event names of the seat stream |
