import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CACHE_RESULT } from '../../core/business-metrics.js';
import { RecordingMetrics } from '../../modules/bookings/testing/recording-metrics.js';
import { openReadOnlyRedis, openTestRedis, openUnresponsiveRedis } from '../../testing/redis.js';
import type { Redis } from '../redis/redis.module.js';
import { CacheAside } from './cache-aside.js';

const CACHE = 'spec.cache';
const TTL_SECONDS = 30;
const ValueSchema = z.object({ name: z.string() });
const VALUE = { name: 'first' };
/** Well above the call bound, well below the test timeout: a hung call fails the test. */
const RESPONSE_BOUND_MS = 2000;

describe('CacheAside', () => {
  let redis: Redis;
  let metrics: RecordingMetrics;
  let cache: CacheAside;
  const keys: string[] = [];
  const freshKey = () => {
    const key = `cache:test:${randomUUID()}`;
    keys.push(key);
    return key;
  };
  const counted = () => metrics.calls.map(({ method, args }) => [method, ...args]);

  beforeAll(async () => {
    redis = await openTestRedis();
  });
  afterAll(async () => {
    await redis.del(keys);
    await redis.quit();
  });
  const fresh = () => {
    metrics = new RecordingMetrics();
    cache = new CacheAside(redis, metrics);
  };

  it('loads once on a miss, then serves the stored value with a lifetime', async () => {
    fresh();
    const key = freshKey();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return VALUE;
    };

    const first = await cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, load);
    const second = await cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, load);

    expect([first, second, loads]).toEqual([VALUE, VALUE, 1]);
    expect(counted()).toEqual([
      ['cacheLookup', CACHE, CACHE_RESULT.MISS],
      ['cacheLookup', CACHE, CACHE_RESULT.HIT],
    ]);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TTL_SECONDS);
  });

  it('does not store null from load', async () => {
    fresh();
    const key = freshKey();

    const result = await cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, async () => null);

    expect(result).toBeNull();
    expect(await redis.exists(key)).toBe(0);
  });

  it('with ttl 0 never touches redis and counts nothing', async () => {
    fresh();
    const key = freshKey();

    const result = await cache.getOrLoad(CACHE, key, ValueSchema, 0, async () => VALUE);

    expect(result).toEqual(VALUE);
    expect(await redis.exists(key)).toBe(0);
    expect(metrics.calls).toEqual([]);
  });

  it('counts MISS for a stored value that fails the schema, replaces it and returns the loaded value', async () => {
    fresh();
    const key = freshKey();
    await redis.set(key, JSON.stringify({ name: 42 }), { EX: TTL_SECONDS });

    const result = await cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, async () => VALUE);

    expect(result).toEqual(VALUE);
    expect(counted()).toEqual([['cacheLookup', CACHE, CACHE_RESULT.MISS]]);
    expect(JSON.parse((await redis.get(key)) ?? 'null')).toEqual(VALUE);
  });

  it('counts MISS for a stored value that is not JSON and replaces it', async () => {
    fresh();
    const key = freshKey();
    await redis.set(key, '{not json', { EX: TTL_SECONDS });

    const result = await cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, async () => VALUE);

    expect(result).toEqual(VALUE);
    expect(counted()).toEqual([['cacheLookup', CACHE, CACHE_RESULT.MISS]]);
    expect(JSON.parse((await redis.get(key)) ?? 'null')).toEqual(VALUE);
  });

  it('falls through to load on a closed client, counts ERROR and does not throw', async () => {
    const closed = await openTestRedis();
    await closed.quit();
    metrics = new RecordingMetrics();
    cache = new CacheAside(closed, metrics);

    const result = await cache.getOrLoad(
      CACHE,
      freshKey(),
      ValueSchema,
      TTL_SECONDS,
      async () => VALUE
    );

    expect(result).toEqual(VALUE);
    expect(counted()).toEqual([['cacheLookup', CACHE, CACHE_RESULT.ERROR]]);
  });

  it('answers within a bound when redis stops answering, counts ERROR', async () => {
    const { client, close } = await openUnresponsiveRedis();
    metrics = new RecordingMetrics();
    cache = new CacheAside(client, metrics);
    const started = Date.now();

    const result = await cache.getOrLoad(
      CACHE,
      freshKey(),
      ValueSchema,
      TTL_SECONDS,
      async () => VALUE
    );

    close();
    expect(result).toEqual(VALUE);
    expect(Date.now() - started).toBeLessThan(RESPONSE_BOUND_MS);
    expect(counted()).toEqual([['cacheLookup', CACHE, CACHE_RESULT.ERROR]]);
  });

  it('invalidate answers within a bound when redis stops answering, counts ERROR', async () => {
    const { client, close } = await openUnresponsiveRedis();
    metrics = new RecordingMetrics();
    const started = Date.now();

    await new CacheAside(client, metrics).invalidate(CACHE, freshKey());

    close();
    expect(Date.now() - started).toBeLessThan(RESPONSE_BOUND_MS);
    expect(counted()).toEqual([['cacheLookup', CACHE, CACHE_RESULT.ERROR]]);
  });

  it('a failed write after the load counts ERROR and still returns the value', async () => {
    const { client, close } = await openReadOnlyRedis();
    metrics = new RecordingMetrics();

    const result = await new CacheAside(client, metrics).getOrLoad(
      CACHE,
      freshKey(),
      ValueSchema,
      TTL_SECONDS,
      async () => VALUE
    );

    await close();
    expect(result).toEqual(VALUE);
    expect(counted()).toEqual([
      ['cacheLookup', CACHE, CACHE_RESULT.MISS],
      ['cacheLookup', CACHE, CACHE_RESULT.ERROR],
    ]);
  });

  it('logs the key and the error message, nothing else', async () => {
    const closed = await openTestRedis();
    await closed.quit();
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const key = freshKey();

    try {
      await new CacheAside(closed, new RecordingMetrics()).getOrLoad(
        CACHE,
        key,
        ValueSchema,
        TTL_SECONDS,
        async () => VALUE
      );

      expect(logged.mock.calls).toEqual([[{ key, message: expect.any(String) }]]);
    } finally {
      logged.mockRestore();
    }
  });

  it('invalidate deletes the keys', async () => {
    fresh();
    const [first, second] = [freshKey(), freshKey()];
    await redis.set(first, '1');
    await redis.set(second, '1');

    await cache.invalidate(CACHE, first, second);

    expect(await redis.exists([first, second])).toBe(0);
  });

  it('invalidate on a closed client resolves and counts ERROR', async () => {
    const closed = await openTestRedis();
    await closed.quit();
    metrics = new RecordingMetrics();

    await expect(
      new CacheAside(closed, metrics).invalidate(CACHE, freshKey())
    ).resolves.toBeUndefined();

    expect(counted()).toEqual([['cacheLookup', CACHE, CACHE_RESULT.ERROR]]);
  });
});
