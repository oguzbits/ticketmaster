# Threat model

STRIDE per trust boundary, mapped to [OWASP ASVS 5.0](https://github.com/OWASP/ASVS/tree/master/5.0/en).
Each threat names its control and the evidence (a spec, an ADR or a document). A control is not
restated here: follow the link. Context: [architecture in the README](../../README.md#architecture),
rules in [AGENTS.md](../../AGENTS.md).

Assets: bookings and their payment state, the identity of a user (only IDs reach logs and tables),
the ticket PDF, the availability of the booking flow.

Actors: an anonymous visitor, a customer, an organizer, an admin, a demo user (temporary customer),
a compromised customer account, and an operator of the host.

## 1. Browser to Caddy (`web`)

| STRIDE | Threat                                                 | Control                                                                                               | Evidence                                                                                                                                                                  |
| ------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | A forged or stolen token is presented                  | Signature, issuer, client (`azp`), algorithm and expiry verified against the JWKS; default-deny guard | [token verifier spec](../../apps/api/src/modules/auth/adapters/jwks-token-verifier.spec.ts), [guard spec](../../apps/api/src/modules/auth/auth.guards.spec.ts)            |
| T      | Script injection (XSS) reads or changes the page       | Content-Security-Policy without inline script, `nosniff`, no referrer, helmet headers                 | [Caddyfile](../../apps/web/Caddyfile), [app setup spec](../../apps/api/src/app.setup.spec.ts)                                                                             |
| R      | A user denies a state change                           | Audit row in the transaction of each of eight actions, IDs only                                       | [audit service spec](../../apps/api/src/modules/audit/audit.service.db.spec.ts)                                                                                           |
| I      | Personal data leaks through logs or headers            | Logs hold IDs and no headers or addresses; `Referrer-Policy: no-referrer`                             | [log spec](../../apps/api/src/infrastructure/logging/http-log.spec.ts)                                                                                                    |
| D      | A flood of requests or held-open streams stalls others | Rate limits per route and client, stream caps, demo login capped                                      | [guard spec](../../apps/api/src/infrastructure/rate-limit/rate-limit.guard.spec.ts), [limiter spec](../../apps/api/src/infrastructure/rate-limit/rate-limiter.db.spec.ts) |
| E      | A customer calls an organizer or admin route           | Roles guard, each protected route tests wrong role and foreign resource                               | [bookings controller spec](../../apps/api/src/modules/bookings/bookings.controller.db.spec.ts), [role screens (e2e)](../../apps/web/e2e/roles.e2e.ts)                     |

## 2. Caddy to the API

| STRIDE | Threat                                           | Control                                                                              | Evidence                                                                                                                      |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| S      | A client forges its address or request ID        | The proxy hop count is fixed; a client request ID counts only if it is a plain token | [request ID spec](../../apps/api/src/infrastructure/logging/request-id.spec.ts), [app setup](../../apps/api/src/app.setup.ts) |
| T      | A request body or query carries unexpected shape | Every input is parsed with a Zod schema from `packages/shared` before use            | [Zod pipe](../../apps/api/src/infrastructure/http/zod.pipe.ts)                                                                |
| D      | One API replica fails                            | Caddy retries a failed connection on the next replica                                | [failover (e2e)](../../apps/web/e2e/failover.e2e.ts)                                                                          |

## 3. API and worker to PostgreSQL (through PgBouncer)

| STRIDE | Threat                                                 | Control                                                                                                                                                                                                  | Evidence                                                                                                                                                       |
| ------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T      | SQL injection                                          | Drizzle parameterizes every value; the dynamic statements (runtime role, test database) take identifiers and values through `format('%I', '%L')` or a constant, in the migration job and test setup only | [role code](../../apps/api/src/infrastructure/database/runtime-role.ts)                                                                                        |
| T      | A seat is booked twice                                 | Four strategies, and a partial unique index as the last line of defense                                                                                                                                  | [ADR 0002](../adr/0002-booking-strategies-and-database-constraint.md), [concurrency spec](../../apps/api/src/modules/bookings/bookings.concurrency.db.spec.ts) |
| T      | A booking jumps to an invalid state                    | One state machine; every transition is stored                                                                                                                                                            | [data model](../data-model.md#booking-state-machine)                                                                                                           |
| I      | A customer reads or changes another customer's booking | Ownership filter in the query, 403 for a foreign booking, and row-level security in the user scope                                                                                                       | [ADR 0009](../adr/0009-row-level-security.md), [RLS spec](../../apps/api/src/infrastructure/database/rls.db.spec.ts)                                           |
| E      | The app login can change the schema or bypass policies | A runtime role without superuser or ownership; the owner `app` migrates and seeds; Keycloak and the PgBouncer auth lookup also log in as `app` (see residual risks)                                      | [runtime role spec](../../apps/api/src/infrastructure/database/runtime-role.db.spec.ts)                                                                        |
| D      | Connections run out under load                         | PgBouncer in transaction mode, bounded pool per process                                                                                                                                                  | [ADR 0005](../adr/0005-pgbouncer-transaction-mode.md), [load tests](../load-tests.md)                                                                          |

## 4. API and worker to Redis

| STRIDE | Threat                                              | Control                                                                                                | Evidence                                                                              |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| T      | A cached value was written wrongly or tampered with | A cached value is parsed again; one that no longer parses counts as a miss                             | [cache spec](../../apps/api/src/infrastructure/cache/cache-aside.db.spec.ts)          |
| T      | A lock or admission key is forged                   | A forged lock cannot book a seat twice: the partial unique index still refuses a second active booking | [Redis lock spec](../../apps/api/src/modules/bookings/adapters/redis-lock.db.spec.ts) |
| D      | Redis is down                                       | Commands time out after 250 ms and the cache falls through to PostgreSQL                               | [cache spec](../../apps/api/src/infrastructure/cache/cache-aside.db.spec.ts)          |

## 5. API and worker to SQS and S3

| STRIDE | Threat                                       | Control                                                                                                                 | Evidence                                                                                                                                          |
| ------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| T      | A message is delivered twice or out of order | Transactional outbox, idempotent consumers keyed by message ID                                                          | [consumer spec](../../apps/worker/src/queue-consumer.db.spec.ts), [outbox spec](../../apps/api/src/modules/outbox/outbox.process-once.db.spec.ts) |
| D      | A poison message blocks the queue            | Moved directly to dead-letter queue (unparsable) or after receive limit (handler failure)                               | [consumer spec](../../apps/worker/src/queue-consumer.db.spec.ts)                                                                                  |
| I      | Someone else downloads a ticket PDF          | The PDF is served only by the API after the ownership check; the code issues no presigned URL and sets no public access | [tickets spec](../../apps/api/src/modules/tickets/tickets.controller.db.spec.ts)                                                                  |

## 6. API to Keycloak

| STRIDE | Threat                                                | Control                                                          | Evidence                                                                                                                                                                                                   |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | A token from another issuer or with another algorithm | Issuer, client and RS256 are fixed in the verifier               | [token verifier spec](../../apps/api/src/modules/auth/adapters/jwks-token-verifier.spec.ts)                                                                                                                |
| D      | The one-click demo login is used to create many users | A cap on live demo users, a TTL, and a cleanup job in the worker | [demo service spec](../../apps/api/src/modules/demo/demo.service.db.spec.ts), [cleanup job spec](../../apps/worker/src/demo-cleanup.job.spec.ts), [ADR 0003](../adr/0003-authentication-and-demo-login.md) |

## 7. Containers and supply chain

| STRIDE | Threat                                             | Control                                                                                    | Evidence                                                                                                                                      |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| E      | A compromised process escapes or widens its rights | Capabilities dropped, no new privileges, read-only root, limits, images pinned by digest   | [container hardening](../../CONTRIBUTING.md#container-hardening), [compose spec](../../apps/api/src/infrastructure/compose-hardening.spec.ts) |
| T      | A vulnerable or tampered dependency or image       | Lockfile, Dependabot, Trivy with SBOM, Semgrep and gitleaks in CI                          | [CI workflow](../../.github/workflows/ci.yml)                                                                                                 |
| I      | A secret reaches the repository or a log           | `.env*` is never read or committed; configuration only through the validated config module | [AGENTS.md](../../AGENTS.md#2-product-invariants), [env spec](../../apps/api/src/config/env.spec.ts)                                          |

## ASVS 5.0 coverage

| Chapter                                 | Where it is covered                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| V2 Validation and Business Logic        | Zod at every boundary; booking rules in the state machine and the idempotency keys of payment                |
| V3 Web Frontend Security                | CSP and headers (section 1); no `HttpClient` in components                                                   |
| V4 API and Web Service                  | Typed contracts in `packages/shared`, rate limits, CORS only for a named origin                              |
| V5 File Handling                        | Ticket PDFs generated by the worker, served by the API with an ownership check                               |
| V8 Authorization                        | Roles guard, ownership filters and row-level security (sections 1 and 3)                                     |
| V9 Self-contained Tokens, V10 OAuth     | Keycloak issues, the API verifies signature, issuer, client, algorithm and expiry (section 6)                |
| V13 Configuration                       | Config module with Zod, hardened containers, pinned images (sections 7)                                      |
| V14 Data Protection                     | IDs only in logs and audit rows; the mail address is read from Keycloak when the mail is sent and not stored |
| V16 Security Logging and Error Handling | Structured logs with request ID, audit log, no silent catch                                                  |

Authentication itself (V6, V7) is delegated to Keycloak and not re-implemented.

## Residual risks

Accepted for now; each is tracked in the [backlog](../BACKLOG.md#open-points).

- The verifier checks the client a token was issued to (`azp`), not an `aud` claim: Keycloak adds
  `aud` only through an audience mapper. A second client of the realm needs its own decision.
- Row-level security is opt-in per path: the ticket download and `claimPaymentKey` have no database
  layer, and the user scope does not stop SQL injection (ADR 0009).
- A refund of a charge that succeeded after the booking left `HELD` that fails is not repeated (it
  needs a manual refund); a charge that throws after the claim leaves the booking stuck until the
  hold and the grace pass.
- The cache breaker for a Redis outage has no single probe call; no retention of audit and outbox rows; the audit table is
  append-only by convention only.
- The local stack uses fixed credentials, publishes Redis on a host port without a password and runs
  Keycloak in `start-dev`. They
  are acceptable on a laptop and must not reach a public host; the live demo (phase 5) replaces
  them, ends TLS at the edge and adds backups.
- Keycloak (its database) and the PgBouncer auth lookup log in as the owner `app`, which is a
  superuser here: row-level security does not apply to them. Only the API and worker use the
  runtime role.
- Alloy reads the Docker socket in the observability profile, which gives it the whole Docker API
  ([risk note](../observability.md#risks-and-limits)).
