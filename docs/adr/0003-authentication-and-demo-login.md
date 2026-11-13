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
  of a password grant on the confidential client `api-demo`. A worker job deletes expired demo users
  in Keycloak and their data. The grant is deprecated in OAuth 2.1; it is accepted here because only
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
  A bad refresh token answers 400 `invalid_grant`.
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
