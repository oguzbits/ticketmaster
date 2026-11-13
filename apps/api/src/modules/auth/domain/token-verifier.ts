import type { AuthUser } from './auth-user.js';

/** Turns a bearer token into the caller. Every failure throws `UnauthorizedException`. */
export interface TokenVerifier {
  verify(token: string): Promise<AuthUser>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
