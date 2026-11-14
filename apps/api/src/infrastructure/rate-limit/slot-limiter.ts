import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { CLOCK, type Clock } from '../../core/clock.js';
import { REDIS, type Redis } from '../redis/redis.module.js';

// One atomic step: drop the slots that ran out, then take the slot if it is already held (a
// refresh) or if a place is free. The sorted set is scored by expiry time, so a slot of a process
// that vanished frees itself; the key's own lifetime removes an idle set.
const ACQUIRE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[2]) or redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[4], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0
`;

/** A slot outlives its stream by this much, so a stream that ends late is never counted as gone. */
export const SLOT_SLACK_MS = 60_000;

const AcquireReplySchema = z.union([z.literal(0), z.literal(1)]);

/** A counted set of open slots in Redis, shared by every API instance. */
@Injectable()
export class SlotLimiter {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** True when the slot is held until `lifetimeMs` from now; false when `limit` live slots exist. */
  async acquire(key: string, slotId: string, limit: number, lifetimeMs: number): Promise<boolean> {
    const now = this.clock.now().getTime();
    const reply = await this.redis.eval(ACQUIRE_SCRIPT, {
      keys: [key],
      arguments: [String(now), slotId, String(limit), String(now + lifetimeMs), String(lifetimeMs)],
    });
    return AcquireReplySchema.parse(reply) === 1;
  }

  async release(key: string, slotId: string): Promise<void> {
    await this.redis.zRem(key, slotId);
  }
}
