import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';

import type { Database } from '../../../infrastructure/database/database.module.js';
import type { Redis } from '../../../infrastructure/redis/redis.module.js';
import type { AuditService } from '../../audit/index.js';
import {
  HOLD_OUTCOME,
  type HoldInput,
  type HoldResult,
  type SeatReservation,
} from '../domain/seat-reservation.js';
import { anySeatTaken, insertHold } from './insert-hold.js';

const LOCK_KEY_PREFIX = 'lock:seat:';
const LOCK_TTL_MS = 5000;
// Deletes the lock only if it still carries our token, so a slow holder cannot free someone else's lock.
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Frees the lock only while it still carries `token`; returns whether it was deleted. */
export async function releaseLock(redis: Redis, key: string, token: string): Promise<boolean> {
  const deleted = await redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
  return deleted === 1;
}

/** Short-lived Redis locks per seat acquired in canonical order; whoever misses one sees a seat as taken. */
export class RedisLockReservation implements SeatReservation {
  private readonly logger = new Logger(RedisLockReservation.name);

  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly audit: AuditService
  ) {}

  async hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult> {
    const ordered = [...input.seatIds].sort();
    const acquired: { key: string; token: string; seatId: string }[] = [];
    try {
      for (const seatId of ordered) {
        const key = `${LOCK_KEY_PREFIX}${seatId}`;
        const token = randomUUID();
        const lockResult = await this.redis.set(key, token, {
          condition: 'NX',
          expiration: { type: 'PX', value: LOCK_TTL_MS },
        });
        if (lockResult === null) return { outcome: HOLD_OUTCOME.SEAT_TAKEN };
        acquired.push({ key, token, seatId });
      }
      return await this.db.transaction(async (tx) =>
        (await anySeatTaken(tx, ordered))
          ? { outcome: HOLD_OUTCOME.SEAT_TAKEN }
          : insertHold(tx, { ...input, seatIds: ordered }, this.audit)
      );
    } finally {
      for (const lock of [...acquired].reverse()) {
        // A failed release must not replace a committed hold; the lock expires by itself after its TTL.
        await releaseLock(this.redis, lock.key, lock.token).catch((error: Error) =>
          this.logger.error(`lock release failed for seat ${lock.seatId}: ${error.message}`)
        );
      }
    }
  }
}
