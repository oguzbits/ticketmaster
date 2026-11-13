import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY } from '@app/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Redis } from '../../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../../testing/database.js';
import { openTestRedis } from '../../../testing/redis.js';
import { HOLD_OUTCOME } from '../domain/seat-reservation.js';
import { RedisLockReservation, releaseLock } from './redis-lock.reservation.js';

describe('releaseLock', () => {
  let redis: Redis;
  const key = `lock:test:${randomUUID()}`;

  beforeAll(async () => {
    redis = await openTestRedis();
  });
  afterAll(async () => {
    await redis.del(key);
    await redis.quit();
  });

  it('keeps a lock that holds another token', async () => {
    await redis.set(key, 'other-token');

    expect(await releaseLock(redis, key, 'my-token')).toBe(false);
    expect(await redis.get(key)).toBe('other-token');
  });

  it('deletes a lock that holds its own token', async () => {
    await redis.set(key, 'my-token');

    expect(await releaseLock(redis, key, 'my-token')).toBe(true);
    expect(await redis.get(key)).toBeNull();
  });

  it('keeps a committed hold when the release fails', async () => {
    const database = openTestDatabase();
    try {
      const { eventId, seatIds } = await createTestEvent(database.db, {
        strategy: BOOKING_STRATEGY.REDIS_LOCK,
        seats: 1,
      });
      const [seatId] = seatIds;
      if (seatId === undefined) throw new Error('test event has no seat');
      const release = vi.spyOn(redis, 'eval').mockRejectedValue(new Error('redis down'));

      const result = await new RedisLockReservation(database.db, redis).hold({
        eventId,
        seatId,
        userId: randomUUID(),
        now: new Date(),
        ttlSeconds: 600,
      });

      expect(release).toHaveBeenCalledOnce();
      expect(result.outcome).toBe(HOLD_OUTCOME.PLACED);
      release.mockRestore();
      await redis.del(`lock:seat:${seatId}`);
    } finally {
      await database.close();
    }
  });
});
