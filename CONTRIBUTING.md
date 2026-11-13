# Contributing

The binding rules (layers, invariants, workflow, test philosophy, Definition of Done) are in
[AGENTS.md](AGENTS.md). This page covers the local setup.

## Setup

Requirements: Node 26 (see `.nvmrc`), pnpm 12 (pinned in `package.json`) and Docker.

```sh
pnpm install                # also installs the Git hooks
pnpm db:up                  # Postgres and Redis for tests
pnpm db:migrate             # apply the migrations and the seed to the local database
pnpm dev                    # API on port 3000, web on port 4200 (proxies /health and /api to the API)
docker compose up --build   # or the whole stack in containers
```

Ports of the local stack (`docker-compose.yml`):

| Service  | Host port | Notes                                             |
| -------- | --------- | ------------------------------------------------- |
| web      | 8080      | Caddy: static web app, proxies `/health/*` and `/api/*` to api |
| keycloak | 8081      | bound to 127.0.0.1; admin console, local admin user `admin` / `admin` |
| postgres | 54330     | databases `app` and `keycloak`, user `app`        |
| redis    | 63790     |                                                   |

`docker compose up` also starts two processes without a host port: `migrate`, a one-shot service
that applies the migrations and the seed with the API image and exits, and `worker`, the scheduled
jobs (hold expiry every two seconds). `api` and `worker` start only after `migrate` has completed.

The credentials in the Compose file are for these local containers only.

Outside production the API falls back to the local containers: `DATABASE_URL`
`postgres://app:app@localhost:54330/app`, `REDIS_URL` `redis://localhost:63790`, `KEYCLOAK_URL`
`http://localhost:8081` and the local demo client secret. To change a
value, export it or put it in an `.env` file in `apps/api` (never committed); the `dev` and `start`
scripts of the API load that file when it exists. With `NODE_ENV=production` these four variables
are required and a missing one fails the start (the Compose file sets them for `migrate`, `api` and
`worker`). Keycloak imports `docker/keycloak/ticketmaster-realm.json` when the realm does not exist
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
| `REDIS_URL` | required |
| `HOLD_TTL_SECONDS` | default `600` |
| `PAYMENT_FAILURE_RATE` | default `0.1` |
| `CORS_ORIGIN` | optional |
| `KEYCLOAK_URL` | required |
| `KEYCLOAK_REALM` | default `ticketmaster` |
| `KEYCLOAK_DEMO_CLIENT_ID` | default `api-demo` |
| `KEYCLOAK_DEMO_CLIENT_SECRET` | required |
| `DEMO_USER_TTL_SECONDS` | default `3600` |
<!-- /generated -->

## Commands

The full table is in [AGENTS.md](AGENTS.md#5-commands). The two that matter most:

- `pnpm check` runs every static gate; the pre-commit hook and CI run the same command.
- `pnpm test` runs the unit tests offline; the pre-push hook runs it.

## Tests

- Unit tests: Vitest, next to the code as `*.spec.ts`. They never reach the network: an unmocked
  request fails the test.
- Database tests are `*.db.spec.ts`. They need `pnpm db:up` and run with `pnpm test:db`; `pnpm test`
  skips them. Before each run a global setup drops and recreates the database `app_test` on the
  server of `DATABASE_URL` (the local container by default) and applies the migrations, so the
  specs never touch the development database `app`. Each test creates its own event with random
  IDs, so no cleanup is needed.
- Route tests start the NestJS module in the test process and call it over the loopback address.
- Web tests run through the Angular builder (`pnpm --filter @app/web test`).

## Commits

Work happens directly on `main`. One topic per commit, [Conventional Commits](https://www.conventionalcommits.org/),
imperative subject. A change to a path in `docs/docs-map.json` needs its document in the same commit
or a line `Docs: n/a, <reason>` in the message. Never bypass the hooks.
