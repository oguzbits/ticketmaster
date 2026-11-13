import { loadEnv } from '../config/config.module.js';
import { createRedisClient, type Redis } from '../infrastructure/redis/redis.module.js';

export async function openTestRedis(): Promise<Redis> {
  const client = createRedisClient(loadEnv().REDIS_URL);
  await client.connect();
  return client;
}
