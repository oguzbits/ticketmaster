import { BOOKING_STRATEGY, type BookingStrategy } from '@app/shared';

import type { Clock } from '../../../core/clock.js';
import type { Database } from '../../../infrastructure/database/database.module.js';
import type { Redis } from '../../../infrastructure/redis/redis.module.js';
import type { AuditService } from '../../audit/index.js';
import type { HoldInput, HoldResult, SeatReservation } from '../domain/seat-reservation.js';
import { NaiveReservation } from './naive.reservation.js';
import { OptimisticReservation } from './optimistic.reservation.js';
import { PessimisticReservation } from './pessimistic.reservation.js';
import { RedisLockReservation } from './redis-lock.reservation.js';

/** The four strategies behind one call; the caller names the strategy of the event. */
export class SeatReservations {
  private readonly byStrategy: Record<BookingStrategy, SeatReservation>;

  private readonly ttlSeconds: number;

  constructor(
    db: Database,
    redis: Redis,
    private readonly clock: Clock,
    hold: { ttlSeconds: number; audit: AuditService }
  ) {
    this.ttlSeconds = hold.ttlSeconds;
    this.byStrategy = {
      [BOOKING_STRATEGY.NAIVE]: new NaiveReservation(db, hold.audit),
      [BOOKING_STRATEGY.PESSIMISTIC]: new PessimisticReservation(db, hold.audit),
      [BOOKING_STRATEGY.OPTIMISTIC]: new OptimisticReservation(db, hold.audit),
      [BOOKING_STRATEGY.REDIS_LOCK]: new RedisLockReservation(db, redis, hold.audit),
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
