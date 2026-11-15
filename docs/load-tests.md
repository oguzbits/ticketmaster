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
The k6 image is pinned by digest and runs hardened like the other services
([container hardening](../CONTRIBUTING.md#container-hardening)); the memory and CPU limits of the stack were
sized from the peaks of these scenarios. It exits with 1 when a threshold is missed. The stack stays up for the next run; remove it, and the
database with it, with:

```bash
COMPOSE_PROJECT_NAME=ticketmaster-klon-load COMPOSE_FILE=docker-compose.yml:docker-compose.loadtest.yml docker compose down --volumes --remove-orphans
```

The load override differs from the default stack in five settings:

| Setting                 | Load run      | Default      | Why                                                              |
| ----------------------- | ------------- | ------------ | ---------------------------------------------------------------- |
| `NODE_ENV` (API)        | `development` | `production` | production refuses a rate limit scale above 1                    |
| `RATE_LIMIT_SCALE`      | `1000`        | `1`          | every limit is multiplied; a 429 in a run is a setup bug         |
| `PAYMENT_FAILURE_RATE`  | `0`           | `0.1`        | a failed payment would count as an error of the system           |
| `DEMO_USER_TTL_SECONDS` | `60`          | `3600`       | the demo login is capped at 200 live users, a run uses up to 190 |
| `TRACING_ENABLED`       | `false`       | `false`      | whatever the shell has set                                       |

The event cache is on (`EVENT_CACHE_TTL_SECONDS`, default 30). Start the runner with
`EVENT_CACHE_TTL_SECONDS=0` in the environment to switch it off for a baseline; the override passes
the variable on to the API containers (check with `docker compose exec api printenv`).

## Scenarios

The scripts live in `scripts/k6`. They pick events by `strategy` and `waitingRoomCapacity` from
`GET /api/events`; no event ID is hard-coded. Customers come from the demo login. Every 429 counts
(`rate_limited`) and every scenario fails on one.

| Scenario       | What it does                                                                                                                                      | Thresholds                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `browse`       | 200 requests per second for 60 s, alternating the event list and one event detail, anonymous                                                      | error rate under 1 %, p95 under 300 ms                                                               |
| `booking-flow` | 40 customers book four seats each of the PESSIMISTIC event: hold a random free seat (another one after a 409), pay with a UUID idempotency key    | error rate under 1 % (a 409 on a taken seat is expected), p95 of hold under 500 ms, of pay under 1 s |
| `rush`         | per strategy, one after the other: 50 customers hold the same seat in one batch, for 10 seats; `double_bookings` counts the 201s beyond the first | no double booking for PESSIMISTIC, OPTIMISTIC and REDIS_LOCK; NAIVE has none, it is the comparison   |
| `waiting-room` | 100 customers join the queue of the event with a waiting room, poll once a second for 20 s and leave                                              | error rate under 1 %, p95 of join and of poll under 300 ms                                           |

`booking-flow` and `rush` take free seats from the event detail and `booking-flow` leaves them paid,
so after a few runs on one database a scenario stops with "no free seat": remove the stack as above.
A run that logs in 190 customers (`all`) fills the demo login; the next one needs the cleanup of the
worker first (about 7 minutes: the TTL, the 300 s grace of the access token and the one-minute job).

## Results

Run on 2026-11-15 on one machine: Apple M4 (10 cores), 16 GiB of memory, Docker with 10 CPUs and
7.7 GiB for its VM (`sysctl -n machdep.cpu.brand_string`, `hw.ncpu`, `hw.memsize`; `docker info`).
Every number comes from one run; a table says which run it is. Treat differences of a millisecond
as noise unless several runs agree.

Limits of every number below:

- Single machine: the load generator shares the CPU with the system under test (two API replicas,
  the worker, PostgreSQL, PgBouncer, Redis, Keycloak, LocalStack and Caddy).
- Payment failure rate 0 and rate limits scaled by 1000 (the load override), so neither the failing
  payment path nor the rate limiter is measured.
- The cache is the Redis cache of the event list and layouts only; seat status is never cached.

### browse: cache off against cache on

`EVENT_CACHE_TTL_SECONDS=0` against the default (30), 200 requests per second for 60 s, each variant
run twice with the second run kept (the first one starts cold). Both variants ran with
`METRICS_ENABLED=true`:

```bash
EVENT_CACHE_TTL_SECONDS=0 METRICS_ENABLED=true pnpm load browse   # twice
METRICS_ENABLED=true pnpm load browse                             # twice
```

| Variant              | p50     | p95     | p99     | Throughput | Error rate | Cache hit ratio |
| -------------------- | ------- | ------- | ------- | ---------- | ---------- | --------------- |
| cache off (TTL 0)    | 1.64 ms | 3.63 ms | 9.71 ms | 199.7 /s   | 0 %        | none, no lookup |
| cache on (TTL 30)    | 1.26 ms | 3.24 ms | 5.30 ms | 199.8 /s   | 0 %        | 99.97 %         |
| cache off, first run | 1.63 ms | 3.45 ms | 7.51 ms | 199.7 /s   | 0 %        |                 |
| cache on, first run  | 1.31 ms | 3.54 ms | 11.5 ms | 194.9 /s   | 0 %        |                 |

The hit ratio is `HIT` over `HIT` and `MISS` of `tm_cache_requests_total` read from the Prometheus
query API (only the `prometheus` service of the `observability` profile was started, to leave the
CPU to the run): 11930 `HIT` and 4 `MISS` at the first scrape after the run (12002 lookups at the
next one, `MISS` unchanged). The four misses are the first list and the first detail on each of
the two replicas; the runner recreates the containers, so every run starts with an empty cache.

What it shows:

- The cache has a measurable but small effect here: the median drops by about 0.4 ms (1.64 to 1.26
  ms). Five cache-on runs had medians of 1.12 to 1.31 ms, both cache-off runs 1.63 and 1.64 ms.
  The p95 differs by 0.4 ms, within the spread of the runs. The p99 does not separate the
  variants: it ranged from 3.6 to 11.5 ms across the cache-on runs.
- Throughput is the same by construction. The scenario fixes the arrival rate at 200 requests per
  second and the system keeps up in both variants, so the run measures latency at a rate far
  below the system's limit (the p95 threshold is 300 ms, the result 3 ms). It sets the ceiling of
  the load generator, not of the system; finding where the cache starts to matter needs a higher
  arrival rate, which the scenario does not offer yet.
- The list and layout queries are cheap on a seeded database of a few events; the cache pays more
  with a larger catalogue or a slower database.

### booking-flow

40 customers book four seats each of the PESSIMISTIC event (160 iterations), a fresh database for
each run, one run per variant (`EVENT_CACHE_TTL_SECONDS=0 pnpm load booking-flow`, then
`pnpm load booking-flow`). The scenario reads the event detail before every hold, so the cache is
in the path.

| Variant           | Step | p50     | p95      | p99      | Throughput (all requests) | Error rate |
| ----------------- | ---- | ------- | -------- | -------- | ------------------------- | ---------- |
| cache off (TTL 0) | hold | 42.1 ms | 124.7 ms | 152.1 ms | 178.7 /s                  | 0 %        |
| cache off (TTL 0) | pay  | 48.1 ms | 90.5 ms  | 93.3 ms  |                           |            |
| cache on (TTL 30) | hold | 42.9 ms | 89.5 ms  | 96.6 ms  | 230.4 /s                  | 0 %        |
| cache on (TTL 30) | pay  | 49.7 ms | 69.5 ms  | 73.9 ms  |                           |            |

The runs last about 3 s, so p95 and p99 rest on 160 samples and the throughput on a short window;
the medians are equal and the gap in the tail is not a result. The earlier run with two seats per
customer (80 iterations, cache on) had a hold p95 of 95.8 ms and a pay p95 of 93.7 ms.

### rush

One run with the cache on (`pnpm load all`), 50 customers per seat, 10 seats per strategy:

| Strategy    | Double bookings      |
| ----------- | -------------------- |
| PESSIMISTIC | 0                    |
| OPTIMISTIC  | 0                    |
| REDIS_LOCK  | 0                    |
| NAIVE       | 271 (the comparison) |

All requests of the scenario: 2058, p50 21.3 ms, p95 71.1 ms, p99 237.4 ms, error rate 0 %,
33.5 requests per second.

### waiting-room

One run with the cache on (`pnpm load all`), 100 customers for about 20 s:

| Request | p50     | p95     | p99     |
| ------- | ------- | ------- | ------- |
| join    | 12.8 ms | 17.4 ms | 22.0 ms |
| poll    | 14.9 ms | 32.2 ms | 39.2 ms |

2301 requests at 99.5 per second, error rate 0 %.
