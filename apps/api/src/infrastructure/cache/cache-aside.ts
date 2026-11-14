import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';

import {
  BUSINESS_METRICS,
  type BusinessMetrics,
  CACHE_RESULT,
} from '../../core/business-metrics.js';
import { REDIS, type Redis } from '../redis/redis.module.js';

/**
 * Cache-aside on Redis (JSON strings with a TTL). This is the one explicit fail-open path of the
 * API: when Redis fails, the read goes to the loader and the error is logged with the key (IDs
 * only), counted as ERROR and never thrown. The TTL bounds how stale a value can get.
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
    const lookup = await this.attempt(key, async () => {
      const raw = await this.redis.get(key);
      return raw === null ? undefined : schema.safeParse(JSON.parse(raw));
    });
    if (!lookup.ok) {
      this.metrics.cacheLookup(cache, CACHE_RESULT.ERROR);
      return load();
    }
    if (lookup.value?.success) {
      this.metrics.cacheLookup(cache, CACHE_RESULT.HIT);
      return lookup.value.data;
    }
    // A value that fails the schema (an old shape after a deploy) is a miss and is replaced below.
    this.metrics.cacheLookup(cache, CACHE_RESULT.MISS);
    const loaded = await load();
    if (loaded !== null) {
      await this.attempt(key, () =>
        this.redis.set(key, JSON.stringify(loaded), { EX: ttlSeconds })
      );
    }
    return loaded;
  }

  /** Never throws; a Redis error is logged. */
  async invalidate(...keys: string[]): Promise<void> {
    await this.attempt(keys.join(','), () => this.redis.del(keys));
  }

  /** The one catch: a failed Redis call is logged with its key and reported, never thrown. */
  private async attempt<T>(
    key: string,
    run: () => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      this.logger.error({
        key,
        message: error instanceof Error ? error.message : 'non-error thrown',
      });
      return { ok: false };
    }
  }
}
