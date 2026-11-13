import { randomUUID } from 'node:crypto';

import type { Database } from '../../../infrastructure/database/database.module.js';
import type { Redis } from '../../../infrastructure/redis/redis.module.js';
import {
  HOLD_OUTCOME,
  type HoldInput,
  type HoldResult,
  type SeatReservation,
} from '../domain/seat-reservation.js';
import { insertHold, isSeatTaken } from './insert-hold.js';

const LOCK_KEY_PREFIX = 'lock:seat:';
const LOCK_TTL_MS = 5000;
// Deletes the lock only if it still carries our token, so a slow holder cannot free someone else's lock.
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** A short-lived Redis lock per seat; whoever does not get it sees the seat as taken. */
export class RedisLockReservation implements SeatReservation {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis
  ) {}

  async hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult> {
    const key = `${LOCK_KEY_PREFIX}${input.seatId}`;
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, {
      condition: 'NX',
      expiration: { type: 'PX', value: LOCK_TTL_MS },
    });
    if (acquired === null) return { outcome: HOLD_OUTCOME.SEAT_TAKEN };
    try {
      return await this.db.transaction(async (tx) =>
        (await isSeatTaken(tx, input.seatId))
          ? { outcome: HOLD_OUTCOME.SEAT_TAKEN }
          : insertHold(tx, input, input.now, input.ttlSeconds)
      );
    } finally {
      await this.redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
    }
  }
}
