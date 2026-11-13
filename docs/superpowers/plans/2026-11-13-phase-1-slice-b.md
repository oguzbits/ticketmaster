# Phase 1, slice B: auth, demo login, booking flow, basic security, live seat map. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visitor logs in with one click as customer, organizer or admin (temporary Keycloak
user), books a seat in the web app (hold, pay, cancel) and sees other viewers' changes live, behind
role checks, ownership checks, security headers, CORS and rate limits.

**Architecture:** A global default-deny guard verifies Keycloak access tokens (JWKS) and reads `sub`
and realm roles. The API creates demo users through the Keycloak Admin API and gets their tokens by
password grant on a confidential client the browser never sees. Bookings, organizer and admin routes
are thin controllers over the slice A services. Every stored booking transition publishes to Redis
after commit; an SSE route fans the channel out. The worker deletes expired demo users.

**Tech Stack:** NestJS 12, `jose` (JWT/JWKS), `helmet`, node-redis, Keycloak 26.8, Angular 22
(signals, RxJS), Playwright. Versions and APIs are read from the installed packages before use.

**Spec:** [phase 1 design](../specs/2026-11-13-phase-1-core-design.md), sections "Slice B" and
"Slice C" (the live seat map joins this slice by the owner's decision, so it is not repeated as a
later slice). Rules: [AGENTS.md](../../../AGENTS.md). Product and UI rules:
[PRODUCT.md](../../../PRODUCT.md), [DESIGN.md](../../../DESIGN.md).

## Global Constraints

- Every rule of AGENTS.md applies (`.js` import suffixes, no `any`/`unknown` parameters,
  `// SAFETY:` on assertions, dictionaries for steering values, no `vi.mock`, no `console`,
  `process.env` only in `src/config`, UI states empty/loading/error+retry/pending).
- Domain code stays pure. Token verification, Keycloak calls, Redis and HTTP are adapters.
- Identity only from the verified token (`sub`); no route reads a user ID from body, query or path.
- Tests are `*.spec.ts` (offline, Keycloak and JWKS through MSW) or `*.db.spec.ts` (Postgres,
  Redis). Every guard has a test that turns red when the guard is removed; try the mutation by hand
  and write it in the commit body. Auth tests live in the spec of each protected route: wrong role
  and foreign resource answer 403, no token answers 401.
- A change in `packages/shared/src/` needs a change under `docs/api/` in the same commit; a change
  in the schema needs `docs/data-model.md` (docs map). Migrations come from `pnpm db:generate`.
- Every new env variable is in `.env.example`; outside production it has a local default (same
  pattern as the connection URLs), in production the Keycloak secret is required.
- Before tests that need infrastructure: `pnpm db:up` and `pnpm db:migrate`; `pnpm test:db`.
- One topic per commit, Conventional Commits, `pnpm check` green, hooks never skipped, push to
  `main`. After the push: `gh run list --branch main --limit 1`.

## Decisions taken in this plan

- **Default-deny.** A global guard on every route; `@Public()` opts out (events read, health,
  demo login, refresh, seat stream). A public route that receives a token still verifies it (a bad
  token answers 401, no silent fallback) and sees the user, so a demo user's sandbox events show up
  for them only.
- **Token refresh through the API:** `POST /api/auth/refresh` with the refresh token, same
  confidential client. The browser never talks to Keycloak.
- **No custom exception filter.** Nest already maps `HttpException` and hides the internals of
  everything else; a test pins that a 500 body carries no message or stack. This drops the spec's
  filter and the backlog note about narrowing `no-unknown-parameters`.
- **Local Keycloak secret** is in the committed realm file and as the local default of
  `KEYCLOAK_DEMO_CLIENT_SECRET` (same status as the compose credentials: local containers only);
  production requires the variable. This answers the backlog question about local secrets.
- **Seat change after a failed publish:** the transition is committed, so a Redis failure is logged
  (not thrown, not swallowed silently) and the request succeeds.
- **Out of scope** (stays in BACKLOG): registration/login with PKCE and GitHub, audit log table,
  runbooks, OpenAPI export, digest pinning, ticket PDF, waiting room, simulator (slice D).

## Review Focus

1. A token with a valid signature but wrong issuer, wrong `alg` (`none`, HS256 with the public key)
   or expired answers 401 (Task 2).
2. A customer pays or cancels another user's booking, or holds a seat of another user's sandbox
   event: 403 resp. 404, nothing changes (Task 4).
3. Rate-limit evasion with a forged `X-Forwarded-For`: only the last proxy hop counts (Task 3).
4. A change committed between the SSE snapshot and the subscription is not lost; a Redis failure
   after commit does not fail the booking request (Task 7).
5. Expired access token mid-flow: the web refreshes once and retries; a failed refresh returns the
   user to the start page without a loop (Task 8).

---

### Task 1: Contracts, env, Keycloak realm, ADR 0003

**Files:**

- Create: `packages/shared/src/auth.ts`, `packages/shared/src/bookings-api.ts`,
  `packages/shared/src/organizer.ts`, `docker/keycloak/ticketmaster-realm.json`,
  `docs/adr/0003-authentication-and-demo-login.md`
- Modify: `packages/shared/src/index.ts`, `apps/api/src/config/env.ts` (+ `env.spec.ts`),
  `.env.example`, `docker-compose.yml`, `docs/api/rest.md`

**Interfaces (Produces):**

- `ROLE = { CUSTOMER: 'customer', ORGANIZER: 'organizer', ADMIN: 'admin' } as const`, `RoleSchema`,
  `Role`.
- `DemoLoginRequestSchema { role: Role }`, `RefreshRequestSchema { refreshToken: string }`,
  `TokenResponseSchema { accessToken, refreshToken, expiresIn: number }`.
- `HoldRequestSchema { eventId: uuid, seatId: uuid }`, `BookingSchema { id, eventId, seatId, status,
holdExpiresAt (ISO), seatLabel info, transitions: { fromStatus|null, toStatus, reason, at }[] }`,
  `BookingListResponseSchema`.
- `VenueSchema { id, name, seatCount }`, `CreateEventRequestSchema { venueId, name, startsAt
(ISO), strategy }`, `OrganizerEventSchema` (summary + `seatCount`, `soldCount`, `heldCount`,
  `utilization` 0..1), `SetStrategyRequestSchema { strategy }`.
- `SeatChangeSchema { eventId, seatId, status: SeatStatus, at (ISO) }` and
  `SEAT_STREAM_EVENT = { SNAPSHOT: 'snapshot', CHANGE: 'change' } as const`.
- Env: `CORS_ORIGIN` (optional URL, unset = no CORS headers), `KEYCLOAK_URL` (default
  `http://localhost:8081`), `KEYCLOAK_REALM` (default `ticketmaster`), `KEYCLOAK_DEMO_CLIENT_ID`
  (default `api-demo`), `KEYCLOAK_DEMO_CLIENT_SECRET`, `DEMO_USER_TTL_SECONDS` (default 3600). The
  Keycloak variables and the secret default to the local values outside production.

**Steps:**

- [ ] Write the failing `env.spec.ts` cases: local defaults outside production; production without
      `KEYCLOAK_DEMO_CLIENT_SECRET` fails and names the variable, not the value; invalid
      `CORS_ORIGIN` fails.
- [ ] Implement schemas and dictionaries (contracts only, nothing else) and the env additions.
- [ ] Realm JSON: realm `ticketmaster`, realm roles `customer`/`organizer`/`admin`, client `web`
      (public, standard flow, PKCE S256, no use yet), client `api-demo` (confidential, direct access
      grants only, service account with `realm-management` roles `manage-users` and `view-users`,
      secret = local default). Compose: mount it, `--import-realm`, `KC_HOSTNAME` unchanged; pass
      the new variables to `api` and `worker`, `KEYCLOAK_URL=http://keycloak:8080`.
- [ ] Verify against the real container (`docker compose up -d keycloak`): password-grant a
      hand-made test user and decode the token: `realm_access.roles` and `iss` as expected. Note
      the issuer you got in the ADR. Keycloak 26 refuses the grant for users without
      `email`/`firstName`/`lastName` ("account not fully set up"); record what Task 5 must set.
- [ ] ADR 0003 (MADR, rejected alternatives): demo login by password grant on a server-only
      confidential client (OAuth 2.1 deprecates the grant; accepted for demo users only), versus
      token exchange, impersonation, fixed seeded users; default-deny guard; refresh through the
      API.
- [ ] `docs/api/rest.md`: dictionaries and the new schemas listed (the rest of the routes arrive
      with their tasks). `pnpm check`, commit `feat(shared): contracts, env and realm for auth`.

---

### Task 2: Token verification, default-deny guard, roles

**Files:**

- Create: `apps/api/src/modules/auth/` with `domain/auth-user.ts`, `adapters/jwks-token-verifier.ts`,
  `jwt-auth.guard.ts`, `roles.guard.ts`, `decorators.ts`, `auth.module.ts`, `index.ts`, specs
- Modify: `apps/api/src/app.module.ts` (APP_GUARD for both guards), `apps/api/package.json`
  (`jose`), `apps/api/src/modules/health/health.controller.ts` (`@Public()`),
  `apps/api/src/modules/events/events.controller.ts` (`@Public()`)

**Interfaces (Produces):**

- `interface AuthUser { id: string; roles: Role[] }` (domain, pure).
- Port `TokenVerifier { verify(token: string): Promise<AuthUser> }` with token `TOKEN_VERIFIER`;
  adapter `JwksTokenVerifier(issuer: string, jwksUrl: URL)` over `jose` (`createRemoteJWKSet`,
  `jwtVerify` with `issuer` and an explicit algorithm allowlist `['RS256']`); roles come from
  `realm_access.roles` parsed with Zod and filtered to `ROLE` values; `sub` must be a UUID. Any
  failure throws `UnauthorizedException`.
- Decorators: `@Public()`, `@Roles(...roles: Role[])`, `@CurrentUser()` (param, `AuthUser`),
  `@OptionalUser()` (param, `AuthUser | null`, for public routes).
- `JwtAuthGuard`: bearer header present → verify, attach user (401 on failure, also on public
  routes); absent → 401 unless `@Public()`. `RolesGuard`: route without `@Roles` is allowed for any
  authenticated user; with `@Roles` the user needs one of them, else 403.

**Tests (`*.spec.ts`, JWKS served by MSW, tokens signed with a key pair generated in the test):**

- verifier: valid token → `AuthUser`; expired, wrong issuer, wrong signature, `alg: none`,
  HS256 signed with the public key as secret, `sub` not a UUID → rejected. Unknown role strings in
  the token are dropped.
- guards through a test controller: no token → 401 (not on `@Public()`); bad token on a `@Public()`
  route → 401; good token on a `@Public()` route → handler sees the user; role missing → 403; role
  present → 200.
- Mutations: remove the `algorithms` allowlist (HS256 test dies), remove the issuer option (issuer
  test dies), make the guard skip verification when the route is public (bad-token test dies),
  remove the role check (403 test dies).

**Steps:** write the specs, see them fail, implement, wire `APP_GUARD` (`JwtAuthGuard` first, then
`RolesGuard`), mark health and events `@Public()`, run the existing `events.controller.db.spec.ts`
(still green), `pnpm check`, commit `feat(api): verify Keycloak tokens, default-deny guard, roles`.

---

### Task 3: Basic security (headers, CORS, rate limits, Caddy CSP)

**Files:**

- Create: `apps/api/src/infrastructure/rate-limit/` (`rate-limiter.ts`, `rate-limit.guard.ts`,
  `rate-limit.decorator.ts`, `rate-limit.module.ts`, specs)
- Modify: `apps/api/src/app.setup.ts` (+ `app.setup.spec.ts`), `apps/api/package.json` (`helmet`),
  `apps/web/Caddyfile`, `docs/api/rest.md`

**Interfaces (Produces):**

- `RATE_LIMIT = { DEFAULT: ..., DEMO_LOGIN: ..., REFRESH: ... } as const` holding
  `{ limit, windowSeconds }` per name: default 120 per 60 s per IP and per user; demo login 5 per
  60 s per IP; refresh 30 per 60 s per IP.
- `RateLimiter.hit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean;
retryAfterSeconds: number }>`: fixed window in Redis (`INCR`, `EXPIRE` on the first hit, atomic).
- `@RateLimit(name)` decorator; `RateLimitGuard` (global, after the auth guard) applies the named
  limit per IP, plus the default limit per user when a user is attached; 429 with `Retry-After`.
- `configureApp`: `helmet()` defaults, `app.set('trust proxy', 1)` (one hop: Caddy), CORS enabled
  only when `CORS_ORIGIN` is set (that origin only, credentials off, methods and headers listed).

**Tests:**

- limiter (`*.db.spec.ts`, real Redis): limit+1-th hit is refused, counter resets after the window
  (fake window of 1 s with the key TTL checked, no sleep in the unit path), keys of different
  names/IPs are independent.
- guard (`*.spec.ts`, fake limiter): 429 and `Retry-After`; per-user limit applies to authenticated
  routes; a forged `X-Forwarded-For: 1.2.3.4, <real>` is keyed by the last hop only.
- `app.setup.spec.ts`: security headers present (`x-content-type-options`, no `x-powered-by`);
  CORS header only for the configured origin and absent for any other; a thrown non-HTTP error
  answers 500 with no message or stack.
- Mutations: drop `trust proxy` (forwarded-for test dies), compare origin loosely (CORS test dies),
  drop the `EXPIRE` (reset test dies).

**Steps:** specs first, implement, Caddyfile: CSP (`default-src 'self'`, no inline scripts; styles
as the Angular build needs, checked in the browser), `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, `frame-ancestors 'none'`. Verify with the running Compose stack that the app
still loads under the CSP (console clean). Commit `feat(api): headers, CORS and Redis rate limits`.

---

### Task 4: Customer booking endpoints and sandbox visibility

**Files:**

- Create: `apps/api/src/modules/bookings/bookings.controller.ts` (+ `bookings.controller.db.spec.ts`)
- Modify: `bookings.service.ts` (`listOwn`, sandbox check in `hold`), `bookings.module.ts`,
  `index.ts`, `events.controller.ts`, `events.service.ts` (+ db spec), `docs/api/rest.md`

**Interfaces:**

- `BookingsService.listOwn(userId: string): Promise<Booking[]>` (shared `Booking`, with its stored
  transitions, newest first). Every query filters by `userId`.
- `BookingsService.hold(input)`: NotFound also when the event is a sandbox event of another user.
- `EventsService.list(userId: string | null)` and `detail(id: string, userId: string | null)`:
  public events plus the events whose `sandboxUserId` is the caller's.
- Routes, all `@Roles(ROLE.CUSTOMER)`: `POST /api/bookings` (`HoldRequestSchema`; 201
  `Booking`; `SEAT_TAKEN` and `CONSTRAINT_VIOLATION` → 409), `POST /api/bookings/:id/payment`
  (header `Idempotency-Key` required, 1–128 chars, else 400; 200 `Booking`),
  `POST /api/bookings/:id/cancel` (200 `Booking`), `GET /api/bookings` (200 `Booking[]`).
  Controllers read the user from `@CurrentUser()` only.

**Tests (`*.db.spec.ts`, fake `TokenVerifier` that maps a test token to an `AuthUser`):**

- hold → 201; the same seat by another customer → 409; seat of another event → 404; non-UUID →
  400; no token → 401; organizer token → 403.
- pay: missing header → 400; same key twice → one charge (provider call count 1) and the same
  answer; another customer's booking → 403 and status unchanged; expired hold → refused, no charge.
- cancel: own HELD and CONFIRMED → CANCELLED; foreign → 403.
- `GET /api/bookings` returns only own bookings with transitions; a second customer's list does not
  contain them.
- sandbox: a seat of a sandbox event of user A cannot be held by user B (404); list/detail show the
  sandbox event to A only, to anonymous callers never.
- Mutations: drop the `userId` filter in `listOwn` (isolation test dies), drop the sandbox check in
  `hold` (404 test dies), drop the header check (400 test dies).

**Steps:** specs first, implement, `pnpm test:db`, `pnpm check`, commit
`feat(api): customer booking endpoints`; the sandbox part is its own commit before it.

---

### Task 5: Demo login, refresh and cleanup

**Files:**

- Create: `apps/api/src/modules/demo/` (`domain/demo-user.ts`, `adapters/keycloak-admin.client.ts`,
  `demo.service.ts`, `demo.controller.ts`, `demo.module.ts`, `index.ts`, specs),
  `apps/worker/src/demo-cleanup.job.ts` (+ spec), `apps/api/drizzle/` migration
- Modify: `apps/api/src/infrastructure/database/schema.ts` (`demo_users`),
  `apps/worker/src/worker.module.ts`, `apps/api/package.json` (`./demo` export),
  `docs/data-model.md`, `docs/api/rest.md`

**Interfaces:**

- Table `demo_users(user_id uuid pk, role, expires_at timestamptz, created_at)`; index on
  `expires_at`.
- Port `KeycloakAdmin`: `createUser(input: { username; email; firstName; lastName; password; role:
Role }): Promise<string /* user id */>`, `deleteUser(id: string): Promise<void>` (404 from
  Keycloak means already gone and counts as success; any other failure throws),
  `passwordGrant(username, password): Promise<TokenResponse>`, `refresh(refreshToken):
Promise<TokenResponse>`. HTTP adapter with `fetch`; admin token through client credentials,
  cached until shortly before expiry using the `Clock`.
- `DemoService.login(role: Role): Promise<TokenResponse>`: random username and password
  (`randomBytes`, generated in the service wiring, not in the domain), create the Keycloak user,
  insert `demo_users` (`expires_at = now + DEMO_USER_TTL_SECONDS`), seed four sandbox events (one
  per strategy, from the HALL venue, owner and `sandbox_user_id` = the user), password grant.
  If a step after the Keycloak user was created fails, the user is deleted again and the error
  rethrown.
- `DemoService.refresh(refreshToken)`; `DemoService.deleteExpired(now: Date): Promise<number>`:
  expired `demo_users` → delete in Keycloak, then their events (cascade removes seats, bookings,
  transitions) and the row, per user in one transaction; a failing user does not stop the others
  (collect and throw an aggregate at the end).
- Routes, `@Public()`: `POST /api/demo-login` (`@RateLimit(DEMO_LOGIN)`, 200 `TokenResponse`,
  invalid role 400), `POST /api/auth/refresh` (`@RateLimit(REFRESH)`; Keycloak 400/401 → 401).
- Worker `DemoCleanupJob` (`@Interval`, 60 s) calling `deleteExpired(clock.now())`.

**Tests:**

- `keycloak-admin.client.spec.ts` (MSW): request shapes (admin token, user create with role
  mapping, password set, grant); 404 on delete is success, 500 throws; the admin token is reused,
  and fetched again after expiry (fake clock).
- `demo.service.db.spec.ts` (fake `KeycloakAdmin`): login creates the row, four sandbox events with
  the user as owner and sandbox user, expiry from the clock; a failing grant deletes the Keycloak
  user again; `deleteExpired` removes only expired users' data and leaves a second, active demo
  user's events and bookings untouched; one Keycloak failure leaves that user's row for the next
  run and the others get cleaned.
- controller spec: role `admin` accepted, `root` → 400; sixth call within the window → 429.
- Mutations: delete without the `expires_at` filter (active-user test dies), skip the cleanup on
  failed grant (rollback test dies), remove `@RateLimit` (429 test dies).

**Steps:** specs first, `pnpm db:generate` for the table, implement, then a manual run against the
real stack (`docker compose up --build`): `curl -X POST localhost:8080/api/demo-login` for all
three roles returns working tokens (set the user fields found in Task 1). Commit as
`feat(demo): demo login`, `feat(worker): clean up expired demo users` and the migration with the
schema.

---

### Task 6: Organizer and admin endpoints

**Files:**

- Create: `apps/api/src/modules/organizer/` (`organizer.controller.ts`, `organizer.service.ts`,
  `organizer.module.ts`, `index.ts`, db spec); modify `events.service.ts`/`events.controller.ts`
  for the strategy switch, `docs/api/rest.md`

**Interfaces:**

- `GET /api/venues` (`@Roles(ORGANIZER)`) → `Venue[]` with `seatCount`.
- `POST /api/events` (`@Roles(ORGANIZER)`, `CreateEventRequestSchema`) → 201 `EventSummary`: copies
  the venue seats with the venue's per-section prices into `seats` in one transaction, `ownerId` =
  caller, `sandboxUserId` = the caller's ID when the caller is a demo user (so a visitor's event
  stays private), else null; unknown venue 404; `startsAt` in the past 400.
- `GET /api/organizer/events` (`@Roles(ORGANIZER)`) → `OrganizerEvent[]`: only own events;
  `soldCount`/`heldCount`/`utilization` computed in one SQL aggregate, never in Node.
- `PATCH /api/events/:id/strategy` (`@Roles(ADMIN)`, `SetStrategyRequestSchema`) → 200
  `EventSummary`; unknown event 404. Existing bookings keep their own `strategy`.

**Tests (`*.db.spec.ts`):** customer on each route → 403; organizer A does not see organizer B's
events in the list; create copies all seats; counts match bookings in each status (HELD, CONFIRMED
counted, EXPIRED/CANCELLED not); strategy switch by admin works and the next hold uses the new
strategy (observed through a hold outcome on a NAIVE event vs a PESSIMISTIC one), by organizer 403.
Mutations: drop the owner filter (isolation test dies), drop `@Roles(ADMIN)` (403 test dies).

**Steps:** specs, implement, `pnpm test:db`, `pnpm check`, commit `feat(api): organizer and admin
endpoints`.

---

### Task 7: Live seat updates (publish after commit, SSE)

**Files:**

- Create: `apps/api/src/modules/bookings/domain/seat-change.ts` (port),
  `adapters/redis-seat-changes.ts`, `apps/api/src/modules/events/seat-stream.controller.ts`,
  `seat-stream.service.ts`, specs
- Modify: `bookings.service.ts`, `bookings.module.ts`, `bookings/testing/create-bookings-service.ts`,
  `events.module.ts`, `docs/api/rest.md`

**Interfaces:**

- Port `SeatChangePublisher { publish(change: SeatChange): Promise<void> }` token
  `SEAT_CHANGE_PUBLISHER`; Redis adapter publishes JSON to channel `seats:<eventId>` (channel name
  built by one function shared with the subscriber).
- `BookingsService` calls it after commit for hold (PLACED), pay (CONFIRMED, or released on
  failure), cancel and `expireHolds` (per expired booking, after each batch commit). Resulting
  status: HELD → `SEAT_STATUS.HELD`, PAID/CONFIRMED → `SOLD`, EXPIRED/CANCELLED → `AVAILABLE`.
  A publish error is logged with the booking ID and not rethrown.
- `SeatStreamService.stream(eventId: string): Observable<SeatStreamMessage>`: one shared node-redis
  subscriber connection per process (own client, closed on shutdown), per-event fan-out with RxJS;
  subscribes to Redis first, then reads the snapshot (`EventsService.detail` seats), emits
  `{ type: SNAPSHOT, seats }` then `{ type: CHANGE, change }`; changes that arrive during the
  snapshot read are buffered and emitted after it (a change older than the snapshot is harmless:
  the client applies by order of arrival).
- `GET /api/events/:id/seats/stream` (`@Public()`, SSE, 404 for unknown or foreign sandbox event,
  heartbeat comment every 15 s).

**Tests:**

- publisher spec (`*.db.spec.ts`, real Redis): hold, pay, cancel and expiry each publish one message
  with the right status; a failed payment publishes `AVAILABLE`; a rolled-back transaction (seat
  taken, 409) publishes nothing; a publisher that throws does not fail `hold` and is logged.
- stream spec (real Redis and Postgres): a change published right after `stream()` is called and
  before the snapshot resolves appears after the snapshot; two subscribers of one event both get a
  change, a subscriber of another event does not; unsubscribing the last client of an event drops
  its Redis subscription.
- controller: unknown event 404; content type `text/event-stream`.
- Mutations: publish before commit (rollback test dies), subscribe after the snapshot (race test
  dies), drop the per-event filter (isolation test dies).

**Steps:** specs, implement, `pnpm test:db`, `pnpm check`, commit
`feat(api): publish seat changes and stream them`.

---

### Task 8: Web session (start page, token store, interceptor)

**Files:**

- Create: `apps/web/src/app/auth/` (`session.store.ts`, `auth.service.ts`, `auth.interceptor.ts`,
  `role.guard.ts`), `apps/web/src/app/start/start-page.ts|html` (+ specs)
- Modify: `app.config.ts`, `app.routes.ts` (start page at `/`, event list moves to `/events`),
  `app.html` (header: role, logout), `events.service.ts`

**Interfaces:**

- `SessionStore`: `session = signal<TokenResponse + { role: Role } | null>`, `isLoggedIn`,
  `role` computed from the access token payload (decoded for display only, never trusted),
  persisted in `sessionStorage` (read and write wrapped so a blocked storage degrades to memory),
  `set()`, `clear()`. Only `*.store.ts` and `*.service.ts` use `HttpClient`.
- `AuthService.demoLogin(role: Role): Observable<void>`, `refresh(): Observable<string>` (shares one
  in-flight refresh), `logout()`.
- `authInterceptor`: adds `Authorization: Bearer …` to `/api` calls except `/api/demo-login` and
  `/api/auth/refresh`; on 401 refreshes once and retries the request once; refresh failure clears
  the session and navigates to `/`. A second 401 after the retry is returned, not retried again.
- `roleGuard(...roles)` route guard: not logged in → `/`; wrong role → `/events`.
- Start page: three buttons (customer, organizer, admin) with pending (disabled, no double
  submit), error with retry (including 429 text), and "browse events without login".

**Tests (`ng test`, `HttpTestingController.verify()`):** button click posts the role and stores the
session; double click sends one request; error state shows retry which works; interceptor adds the
header, skips the two auth routes, refreshes once on 401 and retries, two concurrent 401s cause one
refresh, failed refresh clears the session and navigates, retry that gets 401 again is not looped;
guard cases; storage that throws still works in memory.
Mutations: remove the single-flight (concurrent test dies), remove the retry cap (loop test dies).

**Steps:** specs, implement, inspect in the browser (chrome-devtools MCP): start page, three
logins against the Compose stack, header shows the role. Commit `feat(web): demo login and session`.

---

### Task 9: Web booking flow, organizer and admin screens, live seat map

**Files:**

- Create: `apps/web/src/app/bookings/` (`bookings.service.ts`, `bookings.store.ts`,
  `my-bookings.ts|html`), `apps/web/src/app/organizer/` (`organizer.service.ts`,
  `venue-picker`/`event-form`, `organizer-events.ts|html`), `apps/web/src/app/events/seat-stream.service.ts`,
  `apps/web/src/app/admin/strategy-switch.ts|html` (+ specs for each)
- Modify: `seat-map.ts|html`, `event-list.ts|html`, `app.routes.ts`

**Interfaces:**

- `BookingsService` (`hold`, `pay(bookingId, idempotencyKey)`, `cancel`, `list`); a payment attempt
  generates its `Idempotency-Key` once per attempt and reuses it when the user retries after a
  network error, so a retry cannot charge twice.
- `SeatStreamService.changes(eventId): Observable<SeatStreamMessage>` over `EventSource`, parsed
  with the shared schemas, reconnect with backoff; on reconnect the new snapshot replaces the state.
- Seat map: a signal of seat statuses updated from the stream; customer selects an available seat
  (keyboard reachable) → hold → countdown to `holdExpiresAt` → pay / cancel. States: loading,
  empty, error with retry, pending (disabled controls). A 409 shows "seat taken" and refreshes the
  seat. Hold expired shows its own message. Organizer/admin see the map read-only.
- My bookings (`/bookings`, customer): list with status text and transitions, cancel action.
- Organizer (`/organizer`): own events with utilization, create form (venue list, name, date,
  strategy), four states each. Admin: strategy switch on the event page, confirmed before sending.
- Header links by role. Follow PRODUCT.md/DESIGN.md and the semantic tokens; no ad-hoc colors.

**Tests (`ng test`):** hold → pay → confirmed path shows the right states; 409 on hold updates the
seat and tells the user; double click on pay sends one request; payment retry reuses the key and a
new attempt gets a new one; failed payment shows retry; a stream change marks a seat taken without
reload; reconnect replaces state with the snapshot; customer-only and organizer-only routes guarded;
every list has empty, loading and error with retry.
Mutations: generate a new key on every retry (key test dies), ignore stream changes (live test
dies).

**Steps:** specs, implement, then inspect every screen in the browser as each role (chrome-devtools
MCP): hold, pay, cancel, my bookings, organizer create, admin switch, two tabs. Commit per screen
group (`feat(web): booking flow`, `feat(web): organizer and admin screens`,
`feat(web): live seat map`).

---

### Task 10: End-to-end tests, CI job, docs

**Files:**

- Create: `apps/web/e2e/` (Playwright config and specs), CI job `e2e` in `.github/workflows/`
- Modify: root `package.json` (`e2e` script), `README.md`, `docs/api/rest.md`,
  `docs/data-model.md`, `docs/BACKLOG.md`, `CONTRIBUTING.md`, this plan's ledger

**Steps:**

- [ ] Playwright against the Compose stack (`docker compose up --build --wait`, web on 8080):
      (1) customer demo login → hold → pay → confirmation in "my bookings"; (2) two tabs: a hold in
      tab A marks the seat taken in tab B within one second; (3) organizer and admin logins reach
      their screens and a customer is refused the organizer route. Expiry of a demo user is not run
      here (unit and db tests cover it).
- [ ] Root script `e2e`; CI job `e2e` (builds the stack, installs the browser, uploads the report
      on failure). Fix a red run before anything else.
- [ ] README: requirements, roles and demo login, API table, entities, preliminary architecture
      diagram (Mermaid with Keycloak, API, worker, Redis pub/sub), the unofficial notice stays.
- [ ] BACKLOG: slice B state, new deviations (no custom exception filter, `CORS_ORIGIN` done,
      local secret decision, SSE joined this slice), remove the finished "still open" notes
      (e2e script, filter rule, local secrets), keep runbooks, OpenAPI, digests; next: slice D
      (simulator) and the phase 1 definition of done check.
- [ ] Final whole-branch review with the strongest model (auth, ownership, SSE, rate limit), fix
      wave, `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm e2e` green, push, check CI.
- [ ] Definition-of-Done receipt per feature in the final report, ledger filled, one summary line.

---

## Execution

Dispatch with `umsetzer` (medium model from `CLAUDE_CODE_SUBAGENT_MODEL`, no `model` set). Bundles:
**1+2**, **3**, **4**, **5**, **6+7**, **8**, **9**, **10**. Own review (`pruefer`) only after
bundles 1+2, 4, 5 and 7 (auth, ownership, demo users, stream state); the rest get the group check
and the final whole-branch review on the strongest model. Check `df -h` before the Compose runs.

## Ledger

| Task | Duration | Subagent tokens | Notes |
| ---- | -------- | --------------- | ----- |
