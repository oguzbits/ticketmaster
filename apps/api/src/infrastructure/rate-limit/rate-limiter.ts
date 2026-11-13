import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { REDIS, type Redis } from '../redis/redis.module.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

// One atomic step: count the hit and make sure the key has a lifetime. A key without a TTL would
// block its caller for good, so a missing TTL is repaired on any hit, not only the first.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

const HitReplySchema = z.tuple([z.number(), z.number()]);

/** Fixed-window counter in Redis. */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const reply = await this.redis.eval(HIT_SCRIPT, {
      keys: [key],
      arguments: [String(windowSeconds)],
    });
    const [count, ttl] = HitReplySchema.parse(reply);
    return { allowed: count <= limit, retryAfterSeconds: Math.max(ttl, 1) };
  }
}
