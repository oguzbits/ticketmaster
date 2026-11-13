import { randomInt } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';

import type { AuthUser, TokenVerifier } from '../modules/auth/index.js';

/** A verifier that knows a few test tokens and rejects every other one like the real one does. */
export function fakeTokenVerifier(users: Record<string, AuthUser>): TokenVerifier {
  return {
    verify(token) {
      const user = users[token];
      return user === undefined
        ? Promise.reject(new UnauthorizedException())
        : Promise.resolve(user);
    },
  };
}

/** A fresh client address per call: the rate-limit counters live in Redis and outlast a test run. */
export const randomClientAddress = (): string =>
  `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
