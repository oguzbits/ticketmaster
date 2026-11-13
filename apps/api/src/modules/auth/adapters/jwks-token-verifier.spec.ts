import { randomUUID } from 'node:crypto';

import { ROLE } from '@app/shared';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { type CryptoKey, exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from 'jose';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../testing/mock-server.js';
import { JwksTokenVerifier } from './jwks-token-verifier.js';

const ISSUER = 'http://keycloak.test/realms/ticketmaster';
const JWKS_URL = new URL(`${ISSUER}/protocol/openid-connect/certs`);
const KEY_ID = 'spec-key';
const ONE_HOUR_SECONDS = 3600;

function base64Url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('JwksTokenVerifier', () => {
  let privateKey: CryptoKey;
  let privateJwk: JWK;
  let publicJwk: JWK;
  let verifier: JwksTokenVerifier;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    privateJwk = await exportJWK(pair.privateKey);
    // No `alg` on the key: the verifier's own allowlist is the only thing that fixes the algorithm.
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KEY_ID };
    verifier = new JwksTokenVerifier(ISSUER, JWKS_URL);
  });
  // The shared setup resets the handlers after every test.
  beforeEach(() => {
    server.use(http.get(JWKS_URL.href, () => HttpResponse.json({ keys: [publicJwk] })));
  });

  const claims = (overrides: Record<string, object | string | number> = {}) => ({
    sub: randomUUID(),
    realm_access: { roles: [ROLE.CUSTOMER] },
    ...overrides,
  });

  function sign(
    payload: Record<string, object | string | number>,
    options: {
      issuer?: string;
      expiresAt?: number;
      alg?: string;
      key?: CryptoKey | Uint8Array;
    } = {}
  ): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: KEY_ID })
      .setIssuer(options.issuer ?? ISSUER)
      .setIssuedAt()
      .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1000) + ONE_HOUR_SECONDS)
      .sign(options.key ?? privateKey);
  }

  it('returns the subject and the known realm roles of a valid token', async () => {
    const payload = claims({ realm_access: { roles: [ROLE.ORGANIZER, 'offline_access', 'root'] } });

    const user = await verifier.verify(await sign(payload));

    expect(user).toEqual({ id: payload.sub, roles: [ROLE.ORGANIZER] });
  });

  it('accepts a token without realm roles as a user without roles', async () => {
    const payload = { sub: randomUUID() };

    await expect(verifier.verify(await sign(payload))).resolves.toEqual({
      id: payload.sub,
      roles: [],
    });
  });

  it('rejects an expired token', async () => {
    const token = await sign(claims(), { expiresAt: Math.floor(Date.now() / 1000) - 60 });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token without an expiry', async () => {
    const token = await new SignJWT(claims())
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuer(ISSUER)
      .sign(privateKey);

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token of another issuer', async () => {
    const token = await sign(claims(), { issuer: 'http://evil.test/realms/ticketmaster' });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token signed with another key', async () => {
    const other = await generateKeyPair('RS256');

    const token = await sign(claims(), { key: other.privateKey });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token that names an algorithm outside the allowlist', async () => {
    // Same key material, valid signature, but RS384: only the allowlist stops it.
    const key = await importJWK(privateJwk, 'RS384');

    const token = await sign(claims(), { alg: 'RS384', key });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token with alg none', async () => {
    const token = `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url({
      ...claims(),
      iss: ISSUER,
      exp: Math.floor(Date.now() / 1000) + ONE_HOUR_SECONDS,
    })}.`;

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an HS256 token signed with the public key as the secret', async () => {
    const secret = new TextEncoder().encode(JSON.stringify(publicJwk));
    const token = await new SignJWT(claims())
      .setProtectedHeader({ alg: 'HS256', kid: KEY_ID })
      .setIssuer(ISSUER)
      .setExpirationTime(Math.floor(Date.now() / 1000) + ONE_HOUR_SECONDS)
      .sign(secret);

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a subject that is not a UUID', async () => {
    const token = await sign(claims({ sub: 'admin' }));

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a string that is not a token', async () => {
    await expect(verifier.verify('not-a-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('logging', () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    afterEach(() => {
      debug.mockClear();
      warn.mockClear();
    });

    it('logs a rejected token at debug, by error name only', async () => {
      const token = await sign(claims(), { expiresAt: Math.floor(Date.now() / 1000) - 60 });

      await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);

      expect(debug).toHaveBeenCalledWith(expect.stringContaining('JWTExpired'));
      expect(debug).toHaveBeenCalledWith(expect.not.stringContaining(token));
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ['an HTTP error', () => HttpResponse.json({}, { status: 500 })],
      ['a network error', () => HttpResponse.error()],
    ])('logs an unreachable key set (%s) at warn', async (_name, respond) => {
      // A fresh verifier: the shared one has the key cached already.
      const unreachable = new JwksTokenVerifier(ISSUER, new URL(`${ISSUER}/unreachable`));
      server.use(http.get(`${ISSUER}/unreachable`, respond));
      const token = await sign(claims());

      await expect(unreachable.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.not.stringContaining(token));
      expect(debug).not.toHaveBeenCalled();
    });
  });
});
