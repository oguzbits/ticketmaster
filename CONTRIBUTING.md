# Contributing

The binding rules (layers, invariants, workflow, test philosophy, Definition of Done) are in
[AGENTS.md](AGENTS.md). This page covers the local setup.

## Setup

Requirements: Node 26 (see `.nvmrc`), pnpm 12 (pinned in `package.json`) and Docker.

```sh
pnpm install                # also installs the Git hooks
pnpm db:up                  # Postgres and Redis for tests
pnpm dev                    # API on port 3000, web on port 4200 (proxies /health to the API)
docker compose up --build   # or the whole stack in containers
```

Ports of the local stack (`docker-compose.yml`):

| Service  | Host port | Notes                                             |
| -------- | --------- | ------------------------------------------------- |
| web      | 8080      | Caddy: static web app, proxies `/health/*` to api |
| keycloak | 8081      | admin console, local admin user `admin` / `admin` |
| postgres | 54330     | databases `app` and `keycloak`, user `app`        |
| redis    | 63790     |                                                   |

The credentials in the Compose file are for these local containers only.

## Environment variables

The API validates its environment in `apps/api/src/config/env.ts`. `.env.example` lists every
variable with a comment; the table is generated (`pnpm docs:generate`).

<!-- generated:env -->
| Variable | Kind |
| --- | --- |
| `PORT` | default `3000` |
<!-- /generated -->

## Commands

The full table is in [AGENTS.md](AGENTS.md#5-commands). The two that matter most:

- `pnpm check` runs every static gate; the pre-commit hook and CI run the same command.
- `pnpm test` runs the unit tests offline; the pre-push hook runs it.

## Tests

- Unit tests: Vitest, next to the code as `*.spec.ts`. They never reach the network: an unmocked
  request fails the test.
- Route tests start the NestJS module in the test process and call it over the loopback address.
- Web tests run through the Angular builder (`pnpm --filter @app/web test`).

## Commits

Work happens directly on `main`. One topic per commit, [Conventional Commits](https://www.conventionalcommits.org/),
imperative subject. A change to a path in `docs/docs-map.json` needs its document in the same commit
or a line `Docs: n/a, <reason>` in the message. Never bypass the hooks.
