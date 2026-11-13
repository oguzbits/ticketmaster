import { ROLE } from '@app/shared';
import { Controller, Get, type INestApplication, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AUTH_GUARD_PROVIDERS, Public, TOKEN_VERIFIER } from '../../modules/auth/index.js';
import { RATE_LIMIT, RateLimit } from './rate-limit.decorator.js';
import { rateLimitAddress, RateLimitGuard } from './rate-limit.guard.js';
import { RateLimiter, type RateLimitResult } from './rate-limiter.js';

const RETRY_AFTER_SECONDS = 42;
const USER_ID = '11111111-1111-4111-8111-111111111111';

/** Counts like Redis would, in memory, and records every key it saw. */
class FakeLimiter {
  readonly counts = new Map<string, number>();
  /** Lets every address through, so a test can show what the user counter alone does. */
  ignoreIps = false;

  hit(key: string, limit: number): Promise<RateLimitResult> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    const allowed = count <= limit || (this.ignoreIps && key.includes(':ip:'));
    return Promise.resolve({ allowed, retryAfterSeconds: RETRY_AFTER_SECONDS });
  }
}

@Controller('probe')
class ProbeController {
  @Public()
  @RateLimit('DEMO_LOGIN')
  @Get('strict')
  strict(): { ok: true } {
    return { ok: true };
  }

  @Get('private')
  privateRoute(): { ok: true } {
    return { ok: true };
  }
}

describe('RateLimitGuard', () => {
  let app: INestApplication;
  const limiter = new FakeLimiter();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        ...AUTH_GUARD_PROVIDERS,
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: RateLimiter, useValue: limiter },
        {
          provide: TOKEN_VERIFIER,
          useValue: {
            verify: (token: string) =>
              token === 'good'
                ? Promise.resolve({ id: USER_ID, roles: [ROLE.CUSTOMER] })
                : Promise.reject(new UnauthorizedException()),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // So a spec can pick the client address with X-Forwarded-For.
    app.getHttpAdapter().getInstance().set('trust proxy', true);
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    limiter.counts.clear();
    limiter.ignoreIps = false;
  });

  const get = (path: string, token?: string, client?: string) => {
    const call = request(app.getHttpServer()).get(path);
    if (client !== undefined) call.set('X-Forwarded-For', client);
    return token === undefined ? call : call.set('Authorization', `Bearer ${token}`);
  };

  it('answers 429 with Retry-After once a named limit is used up', async () => {
    for (let hit = 0; hit < RATE_LIMIT.DEMO_LOGIN.limit; hit++) {
      await get('/probe/strict').expect(200);
    }

    const response = await get('/probe/strict').expect(429);

    expect(response.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS));
  });

  it('limits a signed-in caller per user, whatever the address', async () => {
    limiter.ignoreIps = true;
    for (let hit = 0; hit < RATE_LIMIT.DEFAULT.limit; hit++) {
      await get('/probe/private', 'good').expect(200);
    }

    await get('/probe/private', 'good').expect(429);
  });

  it('does not count a request that failed authentication', async () => {
    await get('/probe/private', 'bad').expect(401);

    expect(limiter.counts.size).toBe(0);
  });

  it('counts the addresses of one IPv6 /64 together and other prefixes apart', async () => {
    for (let hit = 0; hit < RATE_LIMIT.DEMO_LOGIN.limit; hit++) {
      await get('/probe/strict', undefined, `2001:db8:1:2::${hit + 1}`).expect(200);
    }

    await get('/probe/strict', undefined, '2001:db8:1:2:ffff::9').expect(429);
    await get('/probe/strict', undefined, '2001:db8:1:3::1').expect(200);
  });
});

describe('rateLimitAddress', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2:abcd:ef01:2345:6789', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b::203.0.113.7', '64:ff9b:0:0::/64'],
  ])('maps %s to %s', (address, expected) => {
    expect(rateLimitAddress(address)).toBe(expected);
  });
});
