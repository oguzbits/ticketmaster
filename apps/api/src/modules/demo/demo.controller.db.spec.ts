import { randomUUID } from 'node:crypto';

import { ROLE, TokenResponseSchema } from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { RATE_LIMIT } from '../../infrastructure/rate-limit/rate-limit.decorator.js';
import { randomClientAddress } from '../../testing/http.js';
import { KEYCLOAK_ADMIN } from './domain/demo-user.js';
import { FAKE_TOKENS, FakeKeycloakAdmin } from './testing/fake-keycloak-admin.js';

describe('demo login and refresh endpoints', () => {
  const keycloak = new FakeKeycloakAdmin();
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KEYCLOAK_ADMIN)
      .useValue(keycloak)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });
  afterAll(() => app.close());

  const post = (path: string, body: object, client = randomClientAddress()) =>
    request(app.getHttpServer()).post(`/api${path}`).set('X-Forwarded-For', client).send(body);

  describe('POST /api/demo-login', () => {
    it('needs no token and answers 200 with the tokens for a known role', async () => {
      const response = await post('/demo-login', { role: ROLE.ADMIN }).expect(200);

      expect(TokenResponseSchema.parse(response.body)).toEqual(FAKE_TOKENS);
      expect(keycloak.created.at(-1)?.role).toBe(ROLE.ADMIN);
    });

    it('answers 400 for an unknown role or a missing body, and creates no user', async () => {
      const before = keycloak.created.length;

      await post('/demo-login', { role: 'root' }).expect(400);
      await post('/demo-login', {}).expect(400);

      expect(keycloak.created).toHaveLength(before);
    });

    it('answers 429 from the sixth call of one client address within the window', async () => {
      const client = randomClientAddress();
      for (let call = 0; call < RATE_LIMIT.DEMO_LOGIN.limit; call++) {
        await post('/demo-login', { role: ROLE.CUSTOMER }, client).expect(200);
      }

      const refused = await post('/demo-login', { role: ROLE.CUSTOMER }, client).expect(429);

      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('needs no token and answers 200 with the new pair', async () => {
      const refreshToken = randomUUID();

      const response = await post('/auth/refresh', { refreshToken }).expect(200);

      expect(TokenResponseSchema.parse(response.body)).toEqual(FAKE_TOKENS);
      expect(keycloak.refreshed).toContain(refreshToken);
    });

    it('answers 400 without a refresh token', async () => {
      await post('/auth/refresh', {}).expect(400);
    });

    it('answers 429 over its own, higher limit', async () => {
      const client = randomClientAddress();
      for (let call = 0; call < RATE_LIMIT.REFRESH.limit; call++) {
        await post('/auth/refresh', { refreshToken: 'any' }, client).expect(200);
      }

      await post('/auth/refresh', { refreshToken: 'any' }, client).expect(429);
    });
  });
});
