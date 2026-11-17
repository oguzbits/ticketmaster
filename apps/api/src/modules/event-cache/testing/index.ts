import { loadEnv } from '../../../config/config.module.js';
import { CacheAside } from '../../../infrastructure/cache/index.js';
import { SystemClock } from '../../../infrastructure/clock/system-clock.js';
import { createRedisClient } from '../../../infrastructure/redis/redis.module.js';
import { RecordingMetrics } from '../../bookings/testing/recording-metrics.js';
import { EventCache } from '../event-cache.js';

/**
 * A cache that is switched off (TTL 0), for services built by hand: the loader always runs and
 * the client is never connected or used.
 */
export function createUncachedEventCache(): EventCache {
  const redis = createRedisClient(loadEnv().REDIS_URL);
  return new EventCache(new CacheAside(redis, new RecordingMetrics(), new SystemClock()), {
    ...loadEnv(),
    EVENT_CACHE_TTL_SECONDS: 0,
  });
}
