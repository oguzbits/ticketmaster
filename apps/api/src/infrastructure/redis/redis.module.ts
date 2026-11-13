import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createClient } from 'redis';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';

/** One place that calls `createClient`, so `Redis` is the exact type it returns (also for the tests). */
export function createRedisClient(url: string) {
  return createClient({ url });
}

export type Redis = ReturnType<typeof createRedisClient>;

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: async (env: Env) => {
        const client = createRedisClient(env.REDIS_URL);
        // node-redis reconnects by itself; without a listener an 'error' event would crash the process.
        client.on('error', (error: Error) => new Logger('Redis').error(error.message));
        await client.connect();
        return client;
      },
      inject: [APP_CONFIG],
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
