import { type Role, RoleSchema } from '@app/shared';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

import type { AuthUser } from '../domain/auth-user.js';
import type { TokenVerifier } from '../domain/token-verifier.js';

const ClaimsSchema = z.object({
  sub: z.uuid(),
  // Keycloak's own roles (offline_access, uma_authorization, ...) sit in the same list; keep ours.
  realm_access: z
    .object({
      roles: z.array(z.string()).transform((names) =>
        names.flatMap((name): Role[] => {
          const role = RoleSchema.safeParse(name);
          return role.success ? [role.data] : [];
        })
      ),
    })
    .optional(),
});

/** Verifies Keycloak access tokens against the realm's JWKS (cached by `jose`). */
export class JwksTokenVerifier implements TokenVerifier {
  private readonly logger = new Logger(JwksTokenVerifier.name);
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly issuer: string,
    jwksUrl: URL
  ) {
    this.keys = createRemoteJWKSet(jwksUrl);
  }

  async verify(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        algorithms: ['RS256'],
        requiredClaims: ['exp'],
      });
      const claims = ClaimsSchema.parse(payload);
      return { id: claims.sub, roles: claims.realm_access?.roles ?? [] };
    } catch (error) {
      // The caller learns "unauthorized" and nothing else; the reason (expired, wrong issuer,
      // unknown key) goes to the log as an error name, never the token.
      this.logger.debug(`token rejected: ${error instanceof Error ? error.name : 'unknown'}`);
      throw new UnauthorizedException();
    }
  }
}
