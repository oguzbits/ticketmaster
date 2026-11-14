# 0005: PgBouncer in transaction mode

- Status: accepted
- Date: 2026-11-14

## Context and problem statement

The API runs as several replicas and the worker as another process, each with its own pool of
PostgreSQL connections. Every process keeps its pool open, so the number of server connections
grows with every replica, while a booking transaction holds a connection only for a few
milliseconds. Which pooler sits between the processes and PostgreSQL, in which mode, and how do we
know the booking code works through it?

## Decision drivers

- No change of the booking logic: row locks (`FOR UPDATE`, `SKIP LOCKED`), advisory locks and the
  concurrency test must behave as against PostgreSQL directly.
- A maintained image of the current PgBouncer release, for amd64 and arm64.
- The behavior is proven by the existing database specs, not assumed.

## Considered options

1. PgBouncer in transaction mode, image `edoburu/pgbouncer`.
2. PgBouncer in session mode.
3. No pooler; each replica keeps a small pool of its own.

## Decision outcome

Chosen: option 1, image `edoburu/pgbouncer:v1.26.1-p0` (PgBouncer 1.26.1, the upstream release of
2026-10-14; multi-arch manifest with amd64 and arm64, published 2026-10-19). There is no official
image: `pgbouncer/pgbouncer` on Docker Hub was last built on 2026-09-20 with 1.25.2.

Settings (`docker-compose.yml`):

| Setting                   | Value           | Why                                                                                                           |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `POOL_MODE`               | `transaction`   | A connection is lent for one transaction; this is the point of the pooler.                                    |
| `AUTH_TYPE`               | `scram-sha-256` | PostgreSQL 18 stores SCRAM hashes, so the pooler logs in with SCRAM (the image writes the plain password).    |
| `DEFAULT_POOL_SIZE`       | `30`            | Server connections per database and user, shared by every replica and the worker; far below PostgreSQL's 100. |
| `MAX_CLIENT_CONN`         | `300`           | Three processes with a pool of 20 each, the 60 connections of the concurrency spec, headroom.                 |
| `MAX_PREPARED_STATEMENTS` | `200`           | Named prepared statements survive a change of server connection (PgBouncer 1.21 and later).                   |

No `DB_NAME`: the image then writes a wildcard database entry, so the database specs reach
`app_test` through the pooler. `migrate` connects to PostgreSQL's own port; the apps and the worker
connect to the pooler. The setup of the database specs uses the `DATABASE_URL` it is given, so
`pnpm test:db:pooled` drops, creates and migrates `app_test` through the pooler as well (`drop
database ... with (force)` ends the idle server connections the pooler holds to it).

Evidence: `pnpm test:db:pooled` runs every database spec with `DATABASE_URL` pointing at the pooler
(the concurrency test, the payment and outbox specs with their advisory locks and `SKIP LOCKED`
batches, the queue consumers): all pass, as they do against PostgreSQL directly. Everything the
code does with a lock or a setting is transaction-bound (`pg_advisory_xact_lock`, `FOR UPDATE`,
`set_config(..., true)`), which transaction mode keeps on one server connection. Drizzle sends
unnamed statements (PgBouncer's statistics show no binds); `pooled-connection.db.spec.ts` uses
`postgres.js` with named statements across many transactions and fails when
`MAX_PREPARED_STATEMENTS` is `0`, so a later named statement cannot break silently.

### Consequences

- Good: the number of PostgreSQL connections no longer grows with every replica.
- Good: no change to the booking code; a session-level feature (session advisory locks,
  `LISTEN`, `SET` without `LOCAL`) would fail the pooled run, which is the guard against adding one.
- Bad: one more container on the path; if it is down, the API and the worker are down. It has a
  health check and the apps wait for it.
- Bad: `pnpm test:db` still defaults to PostgreSQL directly for speed; CI runs the pooled form.
  The pooler's pool is per database and user, so a second database user needs its own sizing.

## Pros and cons of the options

### Option 1: transaction mode

- Good: the best use of server connections; proven by the existing specs.
- Bad: no session state (see above).

### Option 2: session mode

- Good: no restriction on session features.
- Bad: a connection is held as long as the client is connected, so the pooler would save nothing here.

### Option 3: no pooler

- Good: nothing to run.
- Bad: connections grow with the replicas; the plan names PgBouncer.
