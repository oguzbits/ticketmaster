import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CACHE_RESULT } from '../../core/business-metrics.js';
import type { Clock } from '../../core/clock.js';
import { RecordingMetrics } from '../../modules/bookings/testing/recording-metrics.js';
import { openReadOnlyRedis, openTestRedis, openUnresponsiveRedis } from '../../testing/redis.js';
import { SystemClock } from '../clock/system-clock.js';
import type { Redis } from '../redis/redis.module.js';
import { CACHE_BREAKER, CacheAside } from './cache-aside.js';

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
    cache = new CacheAside(redis, metrics, new SystemClock());
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
    cache = new CacheAside(closed, metrics, new SystemClock());

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
    cache = new CacheAside(client, metrics, new SystemClock());
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

    await new CacheAside(client, metrics, new SystemClock()).invalidate(CACHE, freshKey());

    close();
    expect(Date.now() - started).toBeLessThan(RESPONSE_BOUND_MS);
    expect(counted()).toEqual([['cacheLookup', CACHE, CACHE_RESULT.ERROR]]);
  });

  it('a failed write after the load counts ERROR and still returns the value', async () => {
    const { client, close } = await openReadOnlyRedis();
    metrics = new RecordingMetrics();

    const result = await new CacheAside(client, metrics, new SystemClock()).getOrLoad(
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
      await new CacheAside(closed, new RecordingMetrics(), new SystemClock()).getOrLoad(
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
      new CacheAside(closed, metrics, new SystemClock()).invalidate(CACHE, freshKey())
    ).resolves.toBeUndefined();

    expect(counted()).toEqual([['cacheLookup', CACHE, CACHE_RESULT.ERROR]]);
  });

  describe('circuit breaker', () => {
    const readFresh = (breaking: CacheAside) =>
      breaking.getOrLoad(CACHE, freshKey(), ValueSchema, TTL_SECONDS, async () => VALUE);

    it('skips redis after repeated failures, silently, and tries again once the window is over', async () => {
      const closed = await openTestRedis();
      await closed.quit();
      metrics = new RecordingMetrics();
      let nowMs = Date.UTC(2026, 0, 1);
      const clock: Clock = { now: () => new Date(nowMs) };
      const breaking = new CacheAside(closed, metrics, clock);
      for (let i = 0; i < CACHE_BREAKER.FAILURES; i += 1) await readFresh(breaking);
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const calls = vi.spyOn(closed, 'withAbortSignal');

      try {
        const skipped = await readFresh(breaking);
        nowMs += CACHE_BREAKER.OPEN_MS - 1;
        await readFresh(breaking);
        expect([skipped, logged.mock.calls.length, calls.mock.calls.length]).toEqual([VALUE, 0, 0]);
        expect(counted()).toHaveLength(CACHE_BREAKER.FAILURES + 2);

        nowMs += 1;
        await readFresh(breaking);
        expect([logged.mock.calls.length, calls.mock.calls.length]).toEqual([1, 1]);
      } finally {
        logged.mockRestore();
        calls.mockRestore();
      }
    });

    it('a successful call between failures keeps it closed', async () => {
      // Reads succeed on this client and the write after the load fails: one success, one failure.
      const { client, close } = await openReadOnlyRedis();
      metrics = new RecordingMetrics();
      const breaking = new CacheAside(client, metrics, new SystemClock());
      const reads = vi.spyOn(client, 'withAbortSignal');

      for (let i = 0; i <= CACHE_BREAKER.FAILURES; i += 1) await readFresh(breaking);

      expect(reads).toHaveBeenCalledTimes(2 * (CACHE_BREAKER.FAILURES + 1));
      reads.mockRestore();
      await close();
    });
  });

  describe('singleflight', () => {
    it('coalesces concurrent misses for the same key into a single load', async () => {
      fresh();
      const key = freshKey();
      let loads = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const load = async () => {
        loads += 1;
        await gate;
        return VALUE;
      };

      const pending = Promise.all([
        cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, load),
        cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, load),
        cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, load),
      ]);
      // Yield a tick so all callers queue behind the in-flight load before releasing it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();

      expect(await pending).toEqual([VALUE, VALUE, VALUE]);
      expect(loads).toBe(1);
    });

    it('clears the in-flight slot after a failed load so the next call retries', async () => {
      fresh();
      const key = freshKey();
      let attempt = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const load = async () => {
        attempt += 1;
        if (attempt === 1) {
          await gate;
          throw new Error('db timeout');
        }
        return VALUE;
      };

      const first = cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, load);
      const second = cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, load);
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();

      await expect(first).rejects.toThrow('db timeout');
      await expect(second).rejects.toThrow('db timeout');
      expect(attempt).toBe(1);
      await expect(cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, load)).resolves.toEqual(
        VALUE
      );
      expect(attempt).toBe(2);
    });

    it('does not write a stale value to redis when invalidated mid-flight', async () => {
      fresh();
      const key = freshKey();
      const FRESH = { name: 'after-commit' };
      let releaseStale!: () => void;
      const staleGate = new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      let loads = 0;

      const staleRead = cache.getOrLoad(CACHE, key, ValueSchema, TTL_SECONDS, async () => {
        loads += 1;
        await staleGate;
        return VALUE;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await cache.invalidate(CACHE, key);

      const postInvalidateRead = await cache.getOrLoad(
        CACHE,
        key,
        ValueSchema,
        TTL_SECONDS,
        async () => {
          loads += 1;
          return FRESH;
        }
      );
      releaseStale();

      expect(await staleRead).toEqual(VALUE);
      expect(postInvalidateRead).toEqual(FRESH);
      expect(loads).toBe(2);
      expect(JSON.parse((await redis.get(key)) ?? 'null')).toEqual(FRESH);
    });
  });
});
