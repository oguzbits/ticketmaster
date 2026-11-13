import type { Role, TokenResponse } from '@app/shared';

const base64Url = (value: object) =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

/** An unsigned JWT-shaped access token whose payload carries the given realm roles. */
export function accessTokenFor(roles: readonly string[], tag = ''): string {
  return `${base64Url({ alg: 'none' })}.${base64Url({ realm_access: { roles }, tag })}.signature`;
}

/** A token response for a user with one role; `tag` makes two responses differ. */
export function tokensFor(role: Role, tag = ''): TokenResponse {
  return {
    accessToken: accessTokenFor(['offline_access', role], tag),
    refreshToken: `refresh-${role}-${tag}`,
    expiresIn: 300,
  };
}
