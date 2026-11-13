import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTestRedis } from '../../testing/redis.js';
import type { Redis } from '../redis/redis.module.js';
import { RateLimiter } from './rate-limiter.js';

const LIMIT = 3;
const WINDOW_SECONDS = 1;

describe('RateLimiter', () => {
  let redis: Redis;
  let limiter: RateLimiter;
  const keys: string[] = [];
  const freshKey = () => {
    const key = `rl:test:${randomUUID()}`;
    keys.push(key);
    return key;
  };

  beforeAll(async () => {
    redis = await openTestRedis();
    limiter = new RateLimiter(redis);
  });
  afterAll(async () => {
    await redis.del(keys);
    await redis.quit();
  });

  it('allows the limit and refuses the next hit with the time left', async () => {
    const key = freshKey();
    for (let hit = 0; hit < LIMIT; hit++) {
      expect((await limiter.hit(key, LIMIT, WINDOW_SECONDS)).allowed).toBe(true);
    }

    const refused = await limiter.hit(key, LIMIT, WINDOW_SECONDS);

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_SECONDS);
  });

  it('gives the key a lifetime, so the counter resets when the window ends', async () => {
    const key = freshKey();

    await limiter.hit(key, LIMIT, WINDOW_SECONDS);

    const ttlMs = await redis.pTTL(key);
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(WINDOW_SECONDS * 1000);
  });

  it('counts every key on its own', async () => {
    const first = freshKey();
    const second = freshKey();
    for (let hit = 0; hit <= LIMIT; hit++) await limiter.hit(first, LIMIT, WINDOW_SECONDS);

    expect((await limiter.hit(second, LIMIT, WINDOW_SECONDS)).allowed).toBe(true);
  });

  it('counts parallel hits without losing one', async () => {
    const key = freshKey();

    const results = await Promise.all(
      Array.from({ length: LIMIT * 2 }, () => limiter.hit(key, LIMIT, WINDOW_SECONDS))
    );

    expect(results.filter(({ allowed }) => allowed)).toHaveLength(LIMIT);
  });
});
