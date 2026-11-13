import { randomUUID } from 'node:crypto';

import { ROLE } from '@app/shared';
import {
  HttpException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { type DefaultBodyType, http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../testing/mock-server.js';
import type { NewDemoUser } from '../domain/demo-user.js';
import { KeycloakAdminClient } from './keycloak-admin.client.js';

const BASE = 'http://keycloak.test';
const REALM = 'ticketmaster';
const TOKEN_URL = `${BASE}/realms/${REALM}/protocol/openid-connect/token`;
const USERS_URL = `${BASE}/admin/realms/${REALM}/users`;
const CLIENT = { clientId: 'api-demo', clientSecret: 'spec-secret' };
const ADMIN_TOKEN_SECONDS = 60;
const START = new Date('2030-01-01T12:00:00Z');
const NO_CONTENT = 204;
const SHORT_TIMEOUT_MS = 50;

const USER: NewDemoUser = {
  username: 'demo-1',
  email: 'demo-1@demo.invalid',
  firstName: 'Demo',
  lastName: 'User',
  password: 'secret-password',
  role: ROLE.ORGANIZER,
};

const userTokens = { access_token: 'access', refresh_token: 'refresh', expires_in: 300 };

describe('KeycloakAdminClient', () => {
  let now: Date;
  let tokenForms: URLSearchParams[];
  let adminTokens: string[];
  let client: KeycloakAdminClient;

  beforeEach(() => {
    now = START;
    tokenForms = [];
    adminTokens = [];
    client = new KeycloakAdminClient(
      { baseUrl: BASE, realm: REALM, ...CLIENT },
      { now: () => now },
      SHORT_TIMEOUT_MS
    );
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        tokenForms.push(form);
        if (form.get('grant_type') === 'client_credentials') {
          const token = `admin-token-${tokenForms.length}`;
          adminTokens.push(token);
          return HttpResponse.json({ access_token: token, expires_in: ADMIN_TOKEN_SECONDS });
        }
        return HttpResponse.json(userTokens);
      })
    );
  });

  describe('createUser', () => {
    const userId = randomUUID();
    let created: { authorization: string | null; body: DefaultBodyType }[];
    let mapped: { authorization: string | null; body: DefaultBodyType }[];
    let removed: string[];

    beforeEach(() => {
      created = [];
      mapped = [];
      removed = [];
      server.use(
        http.post(USERS_URL, async ({ request }) => {
          created.push({
            authorization: request.headers.get('authorization'),
            body: await request.json(),
          });
          return new HttpResponse(null, {
            status: 201,
            headers: { location: `${USERS_URL}/${userId}` },
          });
        }),
        http.get(`${USERS_URL}/${userId}/role-mappings/realm/available`, () =>
          HttpResponse.json([
            { id: 'role-1', name: ROLE.CUSTOMER },
            { id: 'role-2', name: ROLE.ORGANIZER },
          ])
        ),
        http.post(`${USERS_URL}/${userId}/role-mappings/realm`, async ({ request }) => {
          mapped.push({
            authorization: request.headers.get('authorization'),
            body: await request.json(),
          });
          return new HttpResponse(null, { status: NO_CONTENT });
        }),
        http.delete(`${USERS_URL}/${userId}`, () => {
          removed.push(userId);
          return new HttpResponse(null, { status: NO_CONTENT });
        })
      );
    });

    it('asks for the admin scope, creates the user with a password and maps the role afterwards', async () => {
      const id = await client.createUser(USER);

      expect(id).toBe(userId);
      const [tokenRequest] = tokenForms;
      expect(Object.fromEntries(tokenRequest?.entries() ?? [])).toEqual({
        grant_type: 'client_credentials',
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
        scope: 'kc-admin-api',
      });
      expect(created).toEqual([
        {
          authorization: `Bearer ${adminTokens[0]}`,
          body: {
            username: USER.username,
            email: USER.email,
            firstName: USER.firstName,
            lastName: USER.lastName,
            enabled: true,
            credentials: [{ type: 'password', value: USER.password, temporary: false }],
          },
        },
      ]);
      // Only the requested role, picked by name from the list the service account may read.
      expect(mapped).toEqual([
        {
          authorization: `Bearer ${adminTokens[0]}`,
          body: [{ id: 'role-2', name: ROLE.ORGANIZER }],
        },
      ]);
    });

    it('deletes the user again when the role cannot be mapped', async () => {
      server.use(
        http.post(
          `${USERS_URL}/${userId}/role-mappings/realm`,
          () => new HttpResponse(null, { status: 500 })
        )
      );

      await expect(client.createUser(USER)).rejects.toThrow();

      expect(removed).toEqual([userId]);
    });

    it('deletes the user again when the role is not offered', async () => {
      server.use(
        http.get(`${USERS_URL}/${userId}/role-mappings/realm/available`, () =>
          HttpResponse.json([{ id: 'role-1', name: ROLE.CUSTOMER }])
        )
      );

      await expect(client.createUser(USER)).rejects.toThrow(ROLE.ORGANIZER);

      expect(removed).toEqual([userId]);
    });
  });

  describe('deleteUser', () => {
    const answer = (status: number) =>
      server.use(http.delete(`${USERS_URL}/u1`, () => new HttpResponse(null, { status })));

    it('treats 204 and 404 (already gone) as done', async () => {
      answer(NO_CONTENT);
      await expect(client.deleteUser('u1')).resolves.toBeUndefined();

      answer(404);
      await expect(client.deleteUser('u1')).resolves.toBeUndefined();
    });

    it('throws on any other failure', async () => {
      answer(500);

      await expect(client.deleteUser('u1')).rejects.toThrow('500');
    });
  });

  describe('admin token', () => {
    const answerDelete = () =>
      server.use(
        http.delete(`${USERS_URL}/u1`, () => new HttpResponse(null, { status: NO_CONTENT }))
      );

    it('is reused until shortly before it expires, then fetched again', async () => {
      answerDelete();

      await client.deleteUser('u1');
      await client.deleteUser('u1');
      expect(adminTokens).toHaveLength(1);

      now = new Date(START.getTime() + (ADMIN_TOKEN_SECONDS - 5) * 1000);
      await client.deleteUser('u1');
      expect(adminTokens).toHaveLength(2);
    });
  });

  describe('grants', () => {
    it('logs in with the password grant on the confidential client, without the admin scope', async () => {
      const tokens = await client.passwordGrant(USER.username, USER.password);

      expect(tokens).toEqual({ accessToken: 'access', refreshToken: 'refresh', expiresIn: 300 });
      expect(Object.fromEntries(tokenForms[0]?.entries() ?? [])).toEqual({
        grant_type: 'password',
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
        username: USER.username,
        password: USER.password,
      });
    });

    it('throws when the password grant is refused', async () => {
      server.use(
        http.post(TOKEN_URL, () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }))
      );

      await expect(client.passwordGrant(USER.username, USER.password)).rejects.toThrow('400');
    });

    it('exchanges a refresh token for a new pair', async () => {
      const tokens = await client.refresh('old-refresh');

      expect(tokens.accessToken).toBe('access');
      expect(Object.fromEntries(tokenForms[0]?.entries() ?? [])).toEqual({
        grant_type: 'refresh_token',
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
        refresh_token: 'old-refresh',
      });
    });

    it('answers 401 when Keycloak refuses the refresh token as an invalid grant', async () => {
      server.use(
        http.post(TOKEN_URL, () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }))
      );

      await expect(client.refresh('bad')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    describe('does not blame the caller for a failure of ours', () => {
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      afterEach(() => logged.mockClear());
      afterAll(() => logged.mockRestore());

      it.each([
        ['a wrong client secret', 401, { error: 'invalid_client' }],
        ['another 400 error', 400, { error: 'invalid_request' }],
        ['a 400 without an error code', 400, {}],
        ['a 403', 403, { error: 'access_denied' }],
      ])('answers 500 for %s and logs the status', async (_name, status, body) => {
        server.use(http.post(TOKEN_URL, () => HttpResponse.json(body, { status })));

        const failure = await client.refresh('any').catch((error: Error) => error);

        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(HttpException);
        expect(logged).toHaveBeenCalledWith(expect.stringContaining(String(status)));
      });

      it('answers 503 when Keycloak itself fails, and logs the status', async () => {
        server.use(http.post(TOKEN_URL, () => new HttpResponse('<html>', { status: 502 })));

        await expect(client.refresh('any')).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(logged).toHaveBeenCalledWith(expect.stringContaining('502'));
      });
    });
  });

  describe('a Keycloak that does not answer', () => {
    const never = () => new Promise<never>(() => undefined);

    it('makes the password grant and the refresh answer 503', async () => {
      server.use(http.post(TOKEN_URL, never));

      await expect(client.passwordGrant(USER.username, USER.password)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );
      await expect(client.refresh('any')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('makes an admin call fail instead of succeed, whether the admin API or its token hangs', async () => {
      server.use(http.delete(`${USERS_URL}/u1`, never));
      await expect(client.deleteUser('u1')).rejects.toBeInstanceOf(ServiceUnavailableException);

      now = new Date(START.getTime() + 2 * ADMIN_TOKEN_SECONDS * 1000); // the cached token is stale
      server.use(
        http.post(TOKEN_URL, never),
        http.delete(`${USERS_URL}/u2`, () => new HttpResponse(null, { status: NO_CONTENT }))
      );
      await expect(client.deleteUser('u2')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
