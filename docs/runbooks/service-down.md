# A service is down

Alerts `ApiReplicaMissing` (fewer than 2 API replicas answer), `ApiAllReplicasGone` (none does,
requests fail), `ScrapeTargetDown` (a target does not answer its scrape) and `GaugeSourceMissing`
(the worker is up but cannot read PostgreSQL or SQS for its gauges).

## API replica

```bash
docker compose ps api
docker compose logs --since 10m api
docker compose up -d api        # starts the missing replica again
```

Caddy skips a failed replica for 10 s and retries on the other one, so one missing replica costs
capacity, not requests. `/health/ready` of the running replica shows whether PostgreSQL answers.

## Worker

```bash
docker compose ps worker
docker compose logs --since 10m worker
docker compose up -d worker
```

While the worker is down nothing expires holds, relays the outbox or admits the waiting room; all
of it catches up after the restart. A booking whose hold ran out stays `HELD` until the job runs.

## Scrape target or gauge

`http://localhost:9090/targets` names the target and its error. Every target is down when the stack
runs without `METRICS_ENABLED=true`. For `GaugeSourceMissing` read the worker log for the gauge
error: PostgreSQL or the emulator is unreachable (`docker compose ps postgres pgbouncer aws`).
`OutboxStuck` and `DeadLetterQueueNotEmpty` are blind until it clears.

## Dependency

Only the worker and the pooler have a restart policy (`unless-stopped`): a crash brings them back,
a stop by hand keeps them down. Any other crashed container stays down until
`docker compose up -d <service>`. The apps reconnect to PostgreSQL, PgBouncer and Redis once
they are back. The pooler is one container on the path, so while it is down both API replicas and
the worker fail.
