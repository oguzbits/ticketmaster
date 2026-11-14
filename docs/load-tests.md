# Load tests

k6 scenarios against the local Compose stack. They show where the system bends and what a change
(for example the event cache) buys; they are never a CI gate, and a threshold is a marker for the
person reading the run, not a promise. They run only against the local stack.

## Running

```bash
pnpm load <browse|booking-flow|rush|waiting-room|all>
```

The runner builds and starts the stack under its own Compose project (`ticketmaster-klon-load`, so
the development volume stays untouched) with [docker-compose.loadtest.yml](../docker-compose.loadtest.yml),
then runs the scenario in the `grafana/k6` container (`docker compose --profile loadtest run --rm k6`).
It exits with 1 when a threshold is missed. The stack stays up for the next run; remove it, and the
database with it, with:

```bash
COMPOSE_PROJECT_NAME=ticketmaster-klon-load COMPOSE_FILE=docker-compose.yml:docker-compose.loadtest.yml docker compose down --volumes --remove-orphans
```

The load override differs from the default stack in four settings:

| Setting                 | Load run | Default | Why                                                              |
| ----------------------- | -------- | ------- | ---------------------------------------------------------------- |
| `RATE_LIMIT_SCALE`      | `1000`   | `1`     | every limit is multiplied; a 429 in a run is a setup bug         |
| `PAYMENT_FAILURE_RATE`  | `0`      | `0.1`   | a failed payment would count as an error of the system           |
| `DEMO_USER_TTL_SECONDS` | `60`     | `3600`  | the demo login is capped at 200 live users, a run uses up to 190 |
| `TRACING_ENABLED`       | `false`  | `false` | whatever the shell has set                                       |

The event cache is on (`EVENT_CACHE_TTL_SECONDS`, default 30). Start the runner with
`EVENT_CACHE_TTL_SECONDS=0` in the environment to switch it off for a baseline.

## Scenarios

The scripts live in `scripts/k6`. They pick events by `strategy` and `waitingRoomCapacity` from
`GET /api/events`; no event ID is hard-coded. Customers come from the demo login. Every 429 counts
(`rate_limited`) and every scenario fails on one.

| Scenario       | What it does                                                                                                                                      | Thresholds                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `browse`       | 200 requests per second for 60 s, alternating the event list and one event detail, anonymous                                                      | error rate under 1 %, p95 under 300 ms                                                               |
| `booking-flow` | 40 customers book two seats each of the PESSIMISTIC event: hold a random free seat (another one after a 409), pay with a UUID idempotency key     | error rate under 1 % (a 409 on a taken seat is expected), p95 of hold under 500 ms, of pay under 1 s |
| `rush`         | per strategy, one after the other: 50 customers hold the same seat in one batch, for 10 seats; `double_bookings` counts the 201s beyond the first | no double booking for PESSIMISTIC, OPTIMISTIC and REDIS_LOCK; NAIVE has none, it is the comparison   |
| `waiting-room` | 100 customers join the queue of the event with a waiting room, poll once a second for 20 s and leave                                              | error rate under 1 %, p95 of join and of poll under 300 ms                                           |

`booking-flow` and `rush` take free seats from the event detail and `booking-flow` leaves them paid,
so after a few runs on one database a scenario stops with "no free seat": remove the stack as above.
A run that logs in 190 customers (`all`) fills the demo login; the next one needs the cleanup of the
worker first (about 7 minutes: the TTL, the 300 s grace of the access token and the one-minute job).
