import { ROLE } from '@app/shared';
import { Controller, Get, type INestApplication, UnauthorizedException } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { IS_PUBLIC_KEY, TOKEN_VERIFIER, type TokenVerifier } from './modules/auth/index.js';

const GOOD_TOKEN = 'good-token';
const fakeVerifier: TokenVerifier = {
  verify(token) {
    return token === GOOD_TOKEN
      ? Promise.resolve({ id: '11111111-1111-4111-8111-111111111111', roles: [ROLE.CUSTOMER] })
      : Promise.reject(new UnauthorizedException());
  },
};

// A route nobody marked: only the guards of the real app module can protect it.
@Controller('probe')
class ProbeController {
  @Get()
  bare(): { ok: true } {
    return { ok: true };
  }
}

describe('the real app module', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
      controllers: [ProbeController],
    })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeVerifier)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });
  afterAll(() => app.close());

  const get = (path: string, authorization?: string) => {
    const call = request(app.getHttpServer()).get(path);
    return authorization === undefined ? call : call.set('Authorization', authorization);
  };

  it('health is public', async () => {
    await get('/health/live').expect(200);
    await get('/health/ready').expect(200);
  });

  it('the event list is public', async () => {
    await get('/api/events').expect(200);
  });

  it('an event detail is public', async () => {
    await get('/api/events/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('a route nobody marked answers 401 without a token', async () => {
    await get('/api/probe').expect(401);
  });

  it('no controller is public as a whole, so a new handler is not public by accident', () => {
    const publicControllers = app
      .get(DiscoveryService)
      .getControllers()
      .filter(({ metatype }) => metatype && new Reflector().get(IS_PUBLIC_KEY, metatype))
      .map(({ name }) => name);

    expect(publicControllers).toEqual([]);
  });

  it('a route nobody marked answers 200 with a good token', async () => {
    await get('/api/probe', `Bearer ${GOOD_TOKEN}`).expect(200);
  });

  it('a bad token answers 401, also on a public route', async () => {
    await get('/api/probe', 'Bearer bad-token').expect(401);
    await get('/api/events', 'Bearer bad-token').expect(401);
    await get('/health/live', 'Bearer bad-token').expect(401);
  });
});
