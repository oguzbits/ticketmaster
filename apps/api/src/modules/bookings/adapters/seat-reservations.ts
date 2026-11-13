import { BOOKING_STRATEGY, type BookingStrategy } from '@app/shared';

import type { Clock } from '../../../core/clock.js';
import type { Database } from '../../../infrastructure/database/database.module.js';
import type { Redis } from '../../../infrastructure/redis/redis.module.js';
import type { HoldInput, HoldResult, SeatReservation } from '../domain/seat-reservation.js';
import { NaiveReservation } from './naive.reservation.js';
import { OptimisticReservation } from './optimistic.reservation.js';
import { PessimisticReservation } from './pessimistic.reservation.js';
import { RedisLockReservation } from './redis-lock.reservation.js';

/** The four strategies behind one call; the caller names the strategy of the event. */
export class SeatReservations {
  private readonly byStrategy: Record<BookingStrategy, SeatReservation>;

  constructor(
    db: Database,
    redis: Redis,
    private readonly clock: Clock,
    private readonly ttlSeconds: number
  ) {
    this.byStrategy = {
      [BOOKING_STRATEGY.NAIVE]: new NaiveReservation(db),
      [BOOKING_STRATEGY.PESSIMISTIC]: new PessimisticReservation(db),
      [BOOKING_STRATEGY.OPTIMISTIC]: new OptimisticReservation(db),
      [BOOKING_STRATEGY.REDIS_LOCK]: new RedisLockReservation(db, redis),
    };
  }

  hold(strategy: BookingStrategy, input: HoldInput): Promise<HoldResult> {
    return this.byStrategy[strategy].hold({
      ...input,
      now: this.clock.now(),
      ttlSeconds: this.ttlSeconds,
    });
  }
}
