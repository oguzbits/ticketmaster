import { randomInt, randomUUID } from 'node:crypto';

import { ROLE } from '@app/shared';
import { Controller, Get, type INestApplication, UnauthorizedException } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { RATE_LIMIT, RateLimit } from './infrastructure/rate-limit/rate-limit.decorator.js';
import { IS_PUBLIC_KEY, Public, TOKEN_VERIFIER, type TokenVerifier } from './modules/auth/index.js';

const GOOD_TOKEN = 'good-token';
// New per run: the per-user counter lives in Redis and outlasts a test run.
const USER_ID = randomUUID();
// Only the limit test uses this user, so no other request has used up part of its counter.
const LIMITED_TOKEN = 'limited-token';
const LIMITED_USER_ID = randomUUID();
const fakeVerifier: TokenVerifier = {
  verify(token) {
    if (token === GOOD_TOKEN) return Promise.resolve({ id: USER_ID, roles: [ROLE.CUSTOMER] });
    if (token === LIMITED_TOKEN) {
      return Promise.resolve({ id: LIMITED_USER_ID, roles: [ROLE.CUSTOMER] });
    }
    return Promise.reject(new UnauthorizedException());
  },
};

// A route nobody marked: only the guards of the real app module can protect it.
@Controller('probe')
class ProbeController {
  @Get()
  bare(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @RateLimit('DEMO_LOGIN')
  @Get('limited')
  limited(): { ok: true } {
    return { ok: true };
  }
}

/** A fresh client address per call: the counters live in Redis and outlast a test run. */
const randomAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

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
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
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

  it('limits a @RateLimit route per client address through the app wiring', async () => {
    const client = randomAddress();
    // The proxy appends the real address; whatever the client forged in front of it is ignored.
    const limited = () => get('/api/probe/limited').set('X-Forwarded-For', `1.2.3.4, ${client}`);
    for (let hit = 0; hit < RATE_LIMIT.DEMO_LOGIN.limit; hit++) await limited().expect(200);

    const refused = await limited().expect(429);

    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    await get('/api/probe/limited').set('X-Forwarded-For', randomAddress()).expect(200);
  });

  it('counts a signed-in caller per user, which needs the auth guards to run first', async () => {
    // The user counter is the only one that sees all these addresses at once.
    const user = () => get('/api/probe', `Bearer ${LIMITED_TOKEN}`);
    for (let hit = 0; hit < RATE_LIMIT.DEFAULT.limit; hit++) {
      await user().set('X-Forwarded-For', randomAddress()).expect(200);
    }

    await user().set('X-Forwarded-For', randomAddress()).expect(429);
  });
});
