# 0003: Authentication and demo login

- Status: accepted
- Date: 2026-11-13

## Context and problem statement

Customers, organizers and admins must be told apart on the server, and a visitor of the demo must be
able to try every role in one click, without registering. Keycloak is the identity provider. How does
a visitor get a token, how does the API trust it, and how does the browser keep it fresh?

## Decision drivers

- Identity only from the verified token, never from an ID the client sends (invariant 2).
- A visitor tries a role without a form, and the demo leaves no permanent users behind.
- A route is protected unless someone marks it public on purpose.
- The browser never holds a client secret and never talks to Keycloak in this slice.

## Considered options

1. Demo login by password grant on a server-only confidential client, with a temporary user per login.
2. Token exchange or impersonation of a fixed set of seeded users.
3. Fixed seeded users whose passwords are known to the front end.
4. A guard per controller, opted in.

## Decision outcome

Chosen: option 1, with a global default-deny guard and token refresh through the API.

- `POST /api/demo-login` creates a Keycloak user with a random password and the requested realm
  role, stores it in `demo_users` with an expiry, seeds sandbox events for it and returns the tokens
  of a password grant on the confidential client `api-demo`. A worker job deletes demo users in
  Keycloak and their data once they have expired and their last access token has too (the guard is
  stateless, so a deleted user's token would still book seats; grace `ACCESS_TOKEN_GRACE_SECONDS`
  = `accessTokenLifespan` of the realm file, 300 s). The grant is deprecated in OAuth 2.1; it is accepted here because only
  throw-away demo users use it, the client secret stays on the server and the route is rate limited.
- `POST /api/auth/refresh` exchanges a refresh token on the same client, so the browser only talks
  to the API.
- A global `JwtAuthGuard` verifies every bearer token against the realm JWKS (`jose`, issuer checked,
  algorithm allowlist `RS256`) and reads `sub` and the realm roles. `@Public()` opts a route out; a
  public route that receives a token still verifies it. A global `RolesGuard` applies `@Roles()`.
- The client `web` (public, PKCE `S256`) exists in the realm for the later registration and login
  flow; nothing uses it yet.

### What the real Keycloak 26.8.2 does (checked against the container)

- **Issuer** (`iss`) is built from the host the caller used: `http://localhost:8081/realms/ticketmaster`
  from the host, `http://keycloak:8080/realms/ticketmaster` from the Compose network. The API takes
  both the grant and the JWKS from `KEYCLOAK_URL`, so it verifies against
  `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`; a token must never be verified against a URL the API
  did not call itself. JWKS: `<issuer>/protocol/openid-connect/certs`, keys are `RS256`.
- **Roles** are in `realm_access.roles` next to Keycloak's own roles (`offline_access`,
  `default-roles-ticketmaster`, `uma_authorization`); the guard keeps only `customer`, `organizer`
  and `admin`. `sub` is the user's UUID.
- **Access token** lives 300 s, the refresh token 1800 s; the refresh grant returns a new pair.
  A bad refresh token answers 400 `invalid_grant`; the API maps only that body to 401. A wrong client
  secret answers 401 `invalid_client` and, like any other 4xx or 5xx, is a fault of ours (500, or 503
  for a 5xx), never a bad token.
- **A user needs `email`, `firstName` and `lastName`.** Without them the password grant answers 400
  `invalid_grant` "Account is not fully set up". The demo user gets a random username, an address
  on the reserved `.invalid` domain (no mail is ever sent) and fixed display names.
- **Roles are mapped after the user exists.** `realmRoles` in the create request is ignored without
  an error. The service account may not read a role by name (`GET /roles/{name}` answers 403 without
  `view-realm`), so the adapter lists `GET /users/{id}/role-mappings/realm/available` (allowed with
  `manage-users`), picks the role by name and posts it to `role-mappings/realm`.
- **The admin API needs the client scope `kc-admin-api`.** A client-credentials token without it
  answers 401 ("Token is missing the required admin API scope"). The scope also adds the audience
  `<base>/admin/realms/ticketmaster`. It is an optional scope of `api-demo`, requested only by the
  admin token request (`scope=kc-admin-api`), so user tokens do not carry it.
- Deleting a user answers 204, deleting it again 404 (counts as done).

### Consequences

- Good: no registration form, no permanent demo users, the secret never reaches the browser.
- Good: a forgotten `@Public()` or `@Roles()` fails closed.
- Bad: the grant is deprecated upstream; if Keycloak removes it, the demo login moves to token
  exchange. Only the adapter changes.
- Bad: the local client secret is committed with the realm file and is the local default of
  `KEYCLOAK_DEMO_CLIENT_SECRET`, like the compose credentials: local containers only. Production
  requires the variable.
- Bad: the realm file with its local client secret and the `admin` / `admin` bootstrap of the compose
  Keycloak are local only and must never be imported or reused in production. Compose binds the
  Keycloak port to `127.0.0.1` for the same reason.
- Bad (known gap): the guard accepts the RS256 access token of any client of the realm. It checks
  signature, issuer, expiry and `sub`, but neither `aud` nor `azp`. Acceptable while the realm has
  only this system's clients; revisit before another client is added.
- Bad: a route without `@Roles` accepts any authenticated token, so every new route needs an
  explicit `@Roles(...)` unless any signed-in user really may call it.
- Bad: the public demo login hands out `admin` tokens, so an admin role alone proves nothing. Demo
  admins are scoped to their sandbox: `PATCH /api/events/:id/strategy` accepts a demo user only for
  events whose `sandbox_user_id` is their own, and a regular admin only for public events.

### Known limits of the demo login

- **Orphaned Keycloak user.** If the process dies between `createUser` and the `demo_users` insert,
  the Keycloak user stays and no row ever finds it. There is no reconciliation job yet; one could
  sweep users with the `demo-` prefix that are older than the TTL.
- **Late tokens.** The cleanup waits one access-token lifetime past `expires_at`, but a refresh just
  before the deletion still yields an access token that outlives the user by up to 300 s. Such a token
  can book seats that nothing cleans up. Closing this needs a revocation check in the guard.
- **Refresh tokens are single use.** The realm sets `revokeRefreshToken`, so an old refresh token is
  refused after a refresh (Keycloak then also ends the session when the old one is replayed). The
  realm file is imported only into a fresh Keycloak database; an existing local realm keeps its old
  setting until it is changed in the admin console or the database is recreated.
- **A failing user holds a batch place.** Cleanup takes 100 users per run, oldest first. A user whose
  Keycloak deletion keeps failing is retried first on every run; 100 such users would stall the rest.
- **The global cap counts rows,** not live Keycloak users, so an orphan (above) is not counted.

## Pros and cons of the options

### Option 1: password grant on a confidential client, temporary users

- Good: one standard grant, real tokens, real roles, the API verifies them like any other token.
- Bad: deprecated grant, a user object per login that needs cleanup.

### Option 2: token exchange or impersonation

- Good: no password is handled by the API.
- Bad: needs preview features and extra permissions in Keycloak; more moving parts for a demo.

### Option 3: fixed seeded users

- Good: nothing to clean up.
- Bad: shared state between visitors (one visitor's bookings appear to the next), and the passwords
  would be known to the browser.

### Option 4: a guard per controller

- Good: explicit at each route.
- Bad: a new controller without the guard is open; default-deny cannot be forgotten.
