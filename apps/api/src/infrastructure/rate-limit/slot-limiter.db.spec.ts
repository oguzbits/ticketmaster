import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../../core/clock.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import type { Redis } from '../redis/redis.module.js';
import { SlotLimiter } from './slot-limiter.js';

const LIFETIME_MS = 10_000;

describe('SlotLimiter', () => {
  let redis: Redis;
  let now: Date;
  let limiter: SlotLimiter;
  const keys: string[] = [];
  const freshKey = () => {
    const key = `slots:test:${randomUUID()}`;
    keys.push(key);
    return key;
  };

  beforeAll(async () => {
    redis = await openTestRedis();
    const clock: Clock = { now: () => now };
    limiter = new SlotLimiter(redis, clock);
  });
  afterAll(async () => {
    await redis.del(keys);
    await redis.quit();
  });

  it('refuses the slot above the limit and accepts it again after a release', async () => {
    now = SPEC_NOW;
    const key = freshKey();
    expect(await limiter.acquire(key, 'a', 2, LIFETIME_MS)).toBe(true);
    expect(await limiter.acquire(key, 'b', 2, LIFETIME_MS)).toBe(true);
    expect(await limiter.acquire(key, 'c', 2, LIFETIME_MS)).toBe(false);

    await limiter.release(key, 'a');

    expect(await limiter.acquire(key, 'c', 2, LIFETIME_MS)).toBe(true);
  });

  it('counts only live slots: a slot past its lifetime no longer counts', async () => {
    now = SPEC_NOW;
    const key = freshKey();
    expect(await limiter.acquire(key, 'a', 1, LIFETIME_MS)).toBe(true);
    expect(await limiter.acquire(key, 'b', 1, LIFETIME_MS)).toBe(false);

    now = new Date(SPEC_NOW.getTime() + LIFETIME_MS + 1);

    expect(await limiter.acquire(key, 'b', 1, LIFETIME_MS)).toBe(true);
  });

  it('holds one slot when the same slot id is acquired twice', async () => {
    now = SPEC_NOW;
    const key = freshKey();
    expect(await limiter.acquire(key, 'a', 1, LIFETIME_MS)).toBe(true);
    expect(await limiter.acquire(key, 'a', 1, LIFETIME_MS)).toBe(true);
    expect(await limiter.acquire(key, 'b', 1, LIFETIME_MS)).toBe(false);
  });

  it('lets exactly the limit in when ten acquire at once', async () => {
    now = SPEC_NOW;
    const key = freshKey();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.acquire(key, randomUUID(), 3, LIFETIME_MS))
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it('ignores the release of an unknown slot', async () => {
    now = SPEC_NOW;
    const key = freshKey();
    await expect(limiter.release(key, 'never-acquired')).resolves.toBeUndefined();
  });
});
