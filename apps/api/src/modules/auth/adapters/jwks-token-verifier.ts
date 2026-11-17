import { type Role, RoleSchema } from '@app/shared';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { z } from 'zod';

import { AUTH_PROVIDER, type AuthProvider } from '../../../config/env.js';
import type { AuthUser } from '../domain/auth-user.js';
import type { TokenVerifier } from '../domain/token-verifier.js';

const COGNITO_ACCESS_TOKEN_USE = 'access';

function parseKnownRoles(names: readonly string[]): Role[] {
  return names.flatMap((name): Role[] => {
    const role = RoleSchema.safeParse(name);
    return role.success ? [role.data] : [];
  });
}

function buildClaimsSchema(provider: AuthProvider, clientId: string): z.ZodType<AuthUser> {
  if (provider === AUTH_PROVIDER.COGNITO) {
    return z
      .object({
        sub: z.uuid(),
        token_use: z.literal(COGNITO_ACCESS_TOKEN_USE),
        client_id: z.literal(clientId),
        'cognito:groups': z.array(z.string()).transform(parseKnownRoles).optional(),
      })
      .transform((claims) => ({ id: claims.sub, roles: claims['cognito:groups'] ?? [] }));
  }
  return z
    .object({
      sub: z.uuid(),
      azp: z.literal(clientId),
      // Keycloak's own roles (offline_access, uma_authorization, ...) sit in the same list; keep ours.
      realm_access: z
        .object({
          roles: z.array(z.string()).transform(parseKnownRoles),
        })
        .optional(),
    })
    .transform((claims) => ({ id: claims.sub, roles: claims.realm_access?.roles ?? [] }));
}

/**
 * A bad token (expired, wrong signature, unknown key, odd claims) is the caller's fault; a key set
 * that cannot be fetched or parsed (network error, timeout, HTTP error, bad JSON) is ours. jose
 * reports the latter as a plain `JOSEError` or a non-JOSE error.
 */
function isTokenFault(error: Error): boolean {
  if (error instanceof z.ZodError) return true;
  if (!(error instanceof errors.JOSEError)) return false;
  return !(
    error.code === errors.JOSEError.code ||
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid
  );
}

/** Verifies Keycloak or AWS Cognito RS256 access tokens against the provider's JWKS (cached by `jose`). */
export class JwksTokenVerifier implements TokenVerifier {
  private readonly logger = new Logger(JwksTokenVerifier.name);
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  private readonly claims: z.ZodType<AuthUser>;

  /**
   * `clientId` pins the one client whose tokens are accepted (`azp` in Keycloak, `client_id` +
   * `token_use: 'access'` in Cognito) so tokens issued to another client cannot reach the API.
   */
  constructor(
    private readonly issuer: string,
    jwksUrl: URL,
    clientId: string,
    provider: AuthProvider = AUTH_PROVIDER.KEYCLOAK
  ) {
    this.keys = createRemoteJWKSet(jwksUrl);
    this.claims = buildClaimsSchema(provider, clientId);
  }

  async verify(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        algorithms: ['RS256'],
        requiredClaims: ['exp'],
      });
      return this.claims.parse(payload);
    } catch (error) {
      // The caller learns "unauthorized" and nothing else; the reason goes to the log as an error
      // name, never the token. An unreachable key set is an outage, so it is a warning.
      const name = error instanceof Error ? error.name : 'unknown';
      if (error instanceof Error && isTokenFault(error)) {
        this.logger.debug(`token rejected: ${name}`);
      } else {
        this.logger.warn(`token not verified, key set unavailable or unexpected error: ${name}`);
      }
      throw new UnauthorizedException();
    }
  }
}
