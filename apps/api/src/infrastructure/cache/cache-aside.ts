import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';

import {
  BUSINESS_METRICS,
  type BusinessMetrics,
  CACHE_RESULT,
} from '../../core/business-metrics.js';
import { REDIS, type Redis } from '../redis/redis.module.js';

/**
 * Upper bound of one cache command. node-redis queues commands while it reconnects and has no
 * command timeout, so a stopped Redis would otherwise hang every read that goes through the cache.
 */
export const CACHE_COMMAND_TIMEOUT_MS = 250;

/**
 * Cache-aside on Redis (JSON strings with a TTL). This is the one explicit fail-open path of the
 * API: when Redis fails or does not answer within CACHE_COMMAND_TIMEOUT_MS, the read goes to the
 * loader and the error is logged with the key (IDs only), counted as ERROR and never thrown. The
 * TTL bounds how stale a value can get.
 */
@Injectable()
export class CacheAside {
  private readonly logger = new Logger(CacheAside.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BUSINESS_METRICS) private readonly metrics: BusinessMetrics
  ) {}

  /** ttlSeconds 0: no Redis call, no metric, just `load`. null from `load` is returned and not stored. */
  // eslint-disable-next-line max-params -- the plan fixes this signature for the EventCache callers
  async getOrLoad<S extends z.ZodType>(
    cache: string,
    key: string,
    schema: S,
    ttlSeconds: number,
    load: () => Promise<z.infer<S> | null>
  ): Promise<z.infer<S> | null> {
    if (ttlSeconds === 0) return load();
    const lookup = await this.attempt(cache, key, async (redis) => {
      const raw = await redis.get(key);
      if (raw === null) return undefined;
      try {
        return schema.safeParse(JSON.parse(raw));
      } catch (error) {
        // Text that is not JSON is as unusable as an old shape: a miss, replaced below.
        if (error instanceof SyntaxError) return undefined;
        throw error;
      }
    });
    if (!lookup.ok) return load();
    if (lookup.value?.success) {
      this.metrics.cacheLookup(cache, CACHE_RESULT.HIT);
      return lookup.value.data;
    }
    // A value that fails the schema (an old shape after a deploy) is a miss and is replaced below.
    this.metrics.cacheLookup(cache, CACHE_RESULT.MISS);
    const loaded = await load();
    if (loaded !== null) {
      await this.attempt(cache, key, (redis) =>
        redis.set(key, JSON.stringify(loaded), { EX: ttlSeconds })
      );
    }
    return loaded;
  }

  /** Never throws; a Redis error is logged and counted as ERROR for `cache`. */
  async invalidate(cache: string, ...keys: string[]): Promise<void> {
    await this.attempt(cache, keys.join(','), (redis) => redis.del(keys));
  }

  /** The one catch: a failed or unanswered Redis call is logged with its key, counted, never thrown. */
  private async attempt<T>(
    cache: string,
    key: string,
    run: (redis: Redis) => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    // The signal removes a command that is still queued; a command that was already written can
    // not be taken back, so the race is what ends the wait for its reply.
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`redis did not answer within ${CACHE_COMMAND_TIMEOUT_MS} ms`));
      }, CACHE_COMMAND_TIMEOUT_MS);
    });
    try {
      const value = await Promise.race([run(this.redis.withAbortSignal(abort.signal)), timeout]);
      return { ok: true, value };
    } catch (error) {
      this.metrics.cacheLookup(cache, CACHE_RESULT.ERROR);
      this.logger.error({
        key,
        message: error instanceof Error ? error.message : 'non-error thrown',
      });
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }
}
