# REST API

Contracts are the Zod schemas in `packages/shared`. Every route except the two probes sits under
the `/api` prefix (Caddy forwards `/api/*` and `/health/*` to the API).

| Method and path     | Role   | Answer                                                                                                          |
| ------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | public | 200 `{ status: "UP" }`: the process serves requests                                                             |
| `GET /health/ready` | public | 200 `{ status: "UP" }` when Postgres (`select 1`) and Redis (`PING`) answer, 503 `{ status: "DOWN" }` otherwise |

Every response carries no personal data; requests are logged with the `x-request-id` of the caller
(or a generated one) and the `authorization` and `cookie` headers redacted.

## Dictionaries

`packages/shared` holds the values every contract uses, each as an `as const` dictionary with a Zod
enum and an inferred type.

| Dictionary          | Values                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `BOOKING_STRATEGY`  | `NAIVE`, `PESSIMISTIC`, `OPTIMISTIC`, `REDIS_LOCK`                                              |
| `BOOKING_STATUS`    | `HELD`, `PAID`, `CONFIRMED`, `EXPIRED`, `CANCELLED`                                             |
| `SEAT_STATUS`       | `AVAILABLE`, `HELD`, `SOLD` (derived from the bookings of a seat)                               |
| `TRANSITION_REASON` | `HOLD`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `CONFIRMED`, `HOLD_EXPIRED`, `CANCELLED_BY_USER` |
