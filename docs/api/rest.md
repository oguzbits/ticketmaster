# REST API

Contracts are the Zod schemas in `packages/shared`. Every route except the two probes sits under
the `/api` prefix (Caddy forwards `/api/*` and `/health/*` to the API).

| Method and path       | Role   | Answer                                                                                                                                                                              |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`    | public | 200 `{ status: "UP" }`: the process serves requests                                                                                                                                 |
| `GET /health/ready`   | public | 200 `{ status: "UP" }` when Postgres (`select 1`) and Redis (`PING`) answer, 503 `{ status: "DOWN" }` otherwise                                                                     |
| `GET /api/events`     | public | 200 `EventSummary[]` (`id`, `name`, `startsAt`, `venueName`, `strategy`): public events plus the caller's own sandbox events, ordered by `startsAt`                                 |
| `GET /api/events/:id` | public | 200 `EventDetail` (summary plus `seats`: `id`, `section`, `row`, `number`, `priceCents`, `status`), 400 for a non-UUID id, 404 for an unknown event or another user's sandbox event |

A seat's `status` is derived in one query from its active booking (`HELD`, `PAID` or `CONFIRMED`
occupy the seat) and is `AVAILABLE` when there is none; it is never stored. A sandbox event is
private to its demo user: both routes show it only to a caller whose verified token carries that
user's `sub` (the events routes are public, but a token that is sent is read), and for anyone else
it does not exist.

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
  means the guard fails and the request answers 500.

| Limit        | Applies to                                                    | Counted per                                   | Allowed per window |
| ------------ | ------------------------------------------------------------- | --------------------------------------------- | ------------------ |
| `DEFAULT`    | every route without `@RateLimit`; also every signed-in caller | client address; and user (`sub`) if signed in | 120 per 60 s       |
| `DEMO_LOGIN` | the demo login (replaces `DEFAULT` for the address)           | client address                                | 5 per 60 s         |
| `REFRESH`    | the token refresh (replaces `DEFAULT` for the address)        | client address                                | 30 per 60 s        |

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

| Schema                                                                | Purpose                                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `RoleSchema` (`ROLE`)                                                 | Realm roles: `customer`, `organizer`, `admin`                                                      |
| `DemoLoginRequestSchema`, `RefreshRequestSchema`                      | `{ role }` for the demo login, `{ refreshToken }` for the token refresh                            |
| `TokenResponseSchema`                                                 | `{ accessToken, refreshToken, expiresIn }`                                                         |
| `HoldRequestSchema`                                                   | `{ eventId, seatId }`                                                                              |
| `BookingSchema`, `BookingListResponseSchema`                          | A booking with its seat position and stored transitions (`fromStatus`, `toStatus`, `reason`, `at`) |
| `VenueSchema`, `CreateEventRequestSchema`, `SetStrategyRequestSchema` | Venue templates with `seatCount`; create an event; switch the strategy                             |
| `OrganizerEventSchema`                                                | An event summary with `seatCount`, `soldCount`, `heldCount` and `utilization` (0..1)               |
| `SeatChangeSchema` and `SEAT_STREAM_EVENT` (`snapshot`, `change`)     | One seat's new derived status; the two event names of the seat stream                              |
