# Contributing

The binding rules (layers, invariants, workflow, test philosophy, Definition of Done) are in
[AGENTS.md](AGENTS.md). This page covers the local setup.

## Setup

Requirements: Node 26 (see `.nvmrc`), pnpm 12 (pinned in `package.json`) and Docker.

```sh
pnpm install                # also installs the Git hooks
pnpm db:up                  # Postgres, Redis and the AWS emulator (with its queues and bucket) for tests
pnpm db:migrate             # apply the migrations and the seed to the local database
pnpm dev                    # API on port 3000, web on port 4200 (proxies /health and /api to the API)
docker compose up --build   # or the whole stack in containers
```

Ports of the local stack (`docker-compose.yml`):

| Service  | Host port | Notes                                             |
| -------- | --------- | ------------------------------------------------- |
| web      | 8080      | Caddy: static web app, proxies `/health/*`, `/api/*` and `/storage/*` (presigned tickets) |
| keycloak | 8081      | bound to 127.0.0.1; admin console, local admin user `admin` / `admin` |
| postgres | 54330     | databases `app` and `keycloak`; owner `app`, runtime login `app_runtime` (see below) |
| pgbouncer | 64320    | connection pooler (transaction mode) in front of postgres; api and worker connect through it, see [ADR 0005](docs/adr/0005-pgbouncer-transaction-mode.md) |
| redis    | 63790     |                                                   |
| aws      | 45660     | local AWS emulator (SQS, S3 and SESv2), any credentials, region `us-east-1` |
| mailpit  | 1025, 8025 | mail sink: SMTP on 1025, UI and REST API on 8025; receives worker confirmation mails when `MAIL_PROVIDER=smtp` |

`docker compose up` also starts two `api` replicas (no host port; `docker stop` of one container leaves the app answering, `docker compose stop api` stops both) and three more processes without a host port: `aws-init`, a one-shot service
that applies the declared infrastructure (`INFRASTRUCTURE` in `packages/shared/src/aws.ts`: the queue `booking-events` with its dead-letter queue `booking-events-dlq`, the
bucket `tickets` and the verified SES sender identity) to the emulator and exits (`pnpm aws:init` does the same from the host and prints what it
changed; running it again, or after a resource went missing, converges and changes nothing else, see
[ADR 0006](docs/adr/0006-infrastructure-as-code.md)); `migrate`, a one-shot service
that applies the migrations and the seed with the API image and exits, and `worker`, the scheduled
jobs (hold expiry every two seconds, the simulation reaper every 30 seconds, the simulation retention every minute, the outbox relay every second), the consumer of the rush simulator and the consumer of the queue `booking-events` run. `api` and `worker` start only after `migrate` and `aws-init` have completed.

`pnpm aws:smoke` checks the emulator against the features the async chain relies on (redrive to
the dead-letter queue, visibility timeout, long polling, message attributes, bucket round trip, presigned download, SESv2 email identity and outbound send)
with throw-away resources; it takes about 15 seconds and can run at any time while the emulator
is up. The choice of emulator is in [ADR 0004](docs/adr/0004-local-aws-emulator.md).

Tracing, log correlation and metrics run in the Compose profile `observability` (Tempo, Loki, Alloy,
Prometheus, Grafana on 127.0.0.1:3000, 3100, 3200, 9090). `docker compose up` and `pnpm e2e` do not start it:
`TRACING_ENABLED=true METRICS_ENABLED=true docker compose --profile observability up --build -d` does, and
`GRAFANA_ADMIN_PASSWORD` (default `admin`) sets the Grafana login. How to read a trace, what it
contains and the Docker socket risk of Alloy: [docs/observability.md](docs/observability.md).

The credentials in the Compose file are for these local containers only.

Outside production the API falls back to the local containers: `DATABASE_URL`
`postgres://app_runtime:app_runtime@localhost:54330/app` (the runtime login: no superuser, not the owner, so row-level security applies) and `MIGRATION_DATABASE_URL` `postgres://app:app@localhost:54330/app` (the owner, used only by `pnpm db:migrate`, which also creates the runtime role), `REDIS_URL` `redis://localhost:63790`, `KEYCLOAK_URL`
`http://localhost:8081`, the local demo client secret, `MAIL_PROVIDER` `smtp` with `SMTP_URL` `smtp://localhost:1025`, `AWS_ENDPOINT_URL` `http://localhost:45660` and
the dummy credentials `test` / `test`. To change a
value, export it or put it in an `.env` file in `apps/api` (never committed); the `dev` and `start`
scripts of the API load that file when it exists. With `NODE_ENV=production` the connection URLs, the Keycloak URL and secret and the two AWS
credentials are required (`SMTP_URL` is required only when `MAIL_PROVIDER=smtp`; production defaults to `ses`) and a missing one fails the start (the Compose file sets them for
`migrate`, `api` and `worker`); an unset `AWS_ENDPOINT_URL` then means real AWS. Keycloak imports `docker/keycloak/ticketmaster-realm.json` when the realm does not exist
yet; after a change to that file, delete the realm (or `docker compose down -v`) to import it again.

## Environment variables

The API validates its environment in `apps/api/src/config/env.ts`. `.env.example` lists every
variable with a comment; the table is generated (`pnpm docs:generate`).

<!-- generated:env -->
| Variable | Kind |
| --- | --- |
| `NODE_ENV` | default `development` |
| `PORT` | default `3000` |
| `DATABASE_URL` | required |
| `MIGRATION_DATABASE_URL` | optional |
| `REDIS_URL` | required |
| `HOLD_TTL_SECONDS` | default `600` |
| `PAYMENT_FAILURE_RATE` | default `0.1` |
| `CORS_ORIGIN` | optional |
| `KEYCLOAK_URL` | required |
| `KEYCLOAK_REALM` | default `ticketmaster` |
| `KEYCLOAK_DEMO_CLIENT_ID` | default `api-demo` |
| `KEYCLOAK_DEMO_CLIENT_SECRET` | required |
| `DEMO_USER_TTL_SECONDS` | default `3600` |
| `DEMO_LOGIN_ENABLED` | default `false` |
| `UNSAFE_STRATEGIES_ENABLED` | default `false` |
| `AWS_ENDPOINT_URL` | optional |
| `S3_PRESIGN_BASE_URL` | optional |
| `AWS_REGION` | default `us-east-1` |
| `AWS_ACCESS_KEY_ID` | required |
| `AWS_SECRET_ACCESS_KEY` | required |
| `MAIL_PROVIDER` | default `ses` |
| `SMTP_URL` | optional |
| `MAIL_FROM` | default `tickets@ticketmaster-klon.invalid` |
| `TRACING_ENABLED` | default `false` |
| `TRACING_OTLP_ENDPOINT` | default `http://localhost:4318` |
| `METRICS_ENABLED` | default `false` |
| `METRICS_PORT` | default `9464` |
| `METRICS_HOST` | default `127.0.0.1` |
| `EVENT_CACHE_TTL_SECONDS` | default `30` |
| `RATE_LIMIT_SCALE` | default `1` |
| `GRAFANA_URL` | optional |
<!-- /generated -->

## Container hardening

Every service in `docker-compose.yml` merges the `x-hardening` block: `cap_drop: [ALL]`,
`no-new-privileges` and a read-only root file system, and adds `mem_limit`, `cpus` and the `tmpfs`
paths it writes. Images carry tag and digest (`image: name:tag@sha256:...`; Dependabot moves both),
the `FROM` lines of the `Dockerfile` too. A rule a service cannot meet is named with a reason under
`x-hardening-exception`; `apps/api/src/infrastructure/compose-hardening.spec.ts` fails for a
service that lacks a rule or a reason. It also refuses added capabilities beyond a short list,
host namespaces, `privileged` and a Docker socket mount unless an exception gives the reason.

The worker and the pooler also carry `restart: unless-stopped`: they come back after a crash, not
after a stop by hand ([runbook](docs/runbooks/service-down.md)).

Limits come from `docker stats` during the four `pnpm load` scenarios (the load override, which
sets `NODE_ENV=development`) (peak, 15 November 2026, hardened stack on a
laptop) and sit at about twice the peak. Observability services were measured at idle with data.

| Service    | Peak memory | Limit  | Peak CPU | CPU limit |
| ---------- | ----------- | ------ | -------- | --------- |
| api        | 137 MiB     | 320 MB | 0.32     | 1.0       |
| worker     | 125 MiB     | 256 MB | 0.96     | 2.0       |
| postgres   | 217 MiB     | 512 MB | 0.36     | 1.0       |
| keycloak   | 610 MiB     | 1280 MB | 1.01    | 2.0       |
| aws        | 135 MiB     | 320 MB | 0.09     | 1.0       |
| web        | 61 MiB      | 128 MB | 0.12     | 0.5       |
| redis      | 18 MiB      | 128 MB | 0.04     | 0.25      |
| pgbouncer  | 10 MiB      | 64 MB  | 0.10     | 0.25      |
| mailpit    | 29 MiB      | 64 MB  | 0.05     | 0.25      |

Exceptions: Keycloak (`start-dev` rebuilds its runtime into `/opt/keycloak`, so its root file
system stays writable). Postgres, Redis, the AWS emulator and Alloy keep the few capabilities their
entrypoints need to start as root and drop to their own user.

## Commands

The full table is in [AGENTS.md](AGENTS.md#5-commands). The two that matter most:

- `pnpm check` runs every static gate; the pre-commit hook and CI run the same command.
- `pnpm test` runs the unit tests offline; the pre-push hook runs it.
- `pnpm e2e` runs the browser tests against the whole stack (see below); CI runs it as the `e2e` job.

## Tests

- Unit tests: Vitest, next to the code as `*.spec.ts`. They never reach the network: an unmocked
  request fails the test.
- Database tests are `*.db.spec.ts`. They need `pnpm db:up` (Postgres, Redis and the emulator) and run with `pnpm test:db`; `pnpm test`
  skips them. Before each run a global setup drops and recreates the database `app_test` on the
  server of `MIGRATION_DATABASE_URL` (the local container by default), creates the runtime role and applies the migrations as the owner; the specs themselves connect as the runtime login of `DATABASE_URL`, so the
  specs never touch the development database `app`. `pnpm test:db:pooled` runs the same specs through PgBouncer (`DATABASE_URL` on port 64320); CI runs this form. Each test creates its own event with random
  IDs, so no cleanup is needed.
- Route tests start the NestJS module in the test process and call it over the loopback address.
- Web tests run through the Angular builder (`pnpm --filter @app/web test`).
- End-to-end tests are Playwright specs in `apps/web/e2e`, named `*.e2e.ts` so the unit-test runners
  never pick them up. `pnpm e2e` needs Docker, the ports 8080 and 18025 and the Chromium of Playwright
  (`pnpm --filter @app/web exec playwright install chromium --only-shell`, once). It builds the
  Compose stack under its own project name (`ticketmaster-klon-e2e`, so your development volume is
  untouched), with `docker-compose.e2e.yml` on top: the payment never fails (`PAYMENT_FAILURE_RATE`
  `0`; by default it fails one time in ten) and only web and the Mailpit REST API (port 18025) keep a host port. It runs the specs, prints
  the last log lines of the stack when they fail, and removes the stack and its volume. The demo
  login allows five per minute and address and a run uses four, so wait a minute before running
  the specs again against a stack that is still up (`pnpm e2e` itself starts a fresh one). The HTML
  report of a run is written to `playwright-report` in `apps/web`.

## Commits

Work happens directly on `main`. One topic per commit, [Conventional Commits](https://www.conventionalcommits.org/),
imperative subject. A change to a path in `docs/docs-map.json` needs its document in the same commit
or a line `Docs: n/a, <reason>` in the message. Never bypass the hooks.
