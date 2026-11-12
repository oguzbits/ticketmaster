# REST API

Contracts are the Zod schemas in `packages/shared`. Every route except the two probes sits under
the `/api` prefix (Caddy forwards `/api/*` and `/health/*` to the API).

| Method and path     | Role   | Answer                                                                                                          |
| ------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | public | 200 `{ status: "UP" }`: the process serves requests                                                             |
| `GET /health/ready` | public | 200 `{ status: "UP" }` when Postgres (`select 1`) and Redis (`PING`) answer, 503 `{ status: "DOWN" }` otherwise |

Every response carries no personal data; requests are logged with the `x-request-id` of the caller
(or a generated one) and the `authorization` and `cookie` headers redacted.
