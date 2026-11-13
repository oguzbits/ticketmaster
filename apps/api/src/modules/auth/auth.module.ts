import { Module, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { JwksTokenVerifier } from './adapters/jwks-token-verifier.js';
import { TOKEN_VERIFIER } from './domain/token-verifier.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';

/**
 * The global guards in their required order: token first, then roles. The app module spreads this
 * list so later global guards (rate limits) follow them.
 */
export const AUTH_GUARD_PROVIDERS: Provider[] = [
  { provide: APP_GUARD, useClass: JwtAuthGuard },
  { provide: APP_GUARD, useClass: RolesGuard },
];

@Module({
  providers: [
    {
      provide: TOKEN_VERIFIER,
      useFactory: (env: Env) => {
        // The API reaches Keycloak at KEYCLOAK_URL, and Keycloak names itself after the host it was
        // reached at, so the issuer is derived from the same URL.
        const issuer = `${env.KEYCLOAK_URL}/realms/${env.KEYCLOAK_REALM}`;
        return new JwksTokenVerifier(issuer, new URL(`${issuer}/protocol/openid-connect/certs`));
      },
      inject: [APP_CONFIG],
    },
  ],
  exports: [TOKEN_VERIFIER],
})
export class AuthModule {}
