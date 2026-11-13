import { BOOKING_STRATEGY, type BookingStrategy } from '@app/shared';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, inArray, sql } from 'drizzle-orm';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { bookings, events, seats } from '../../infrastructure/database/schema.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { NaiveReservation } from './adapters/naive.reservation.js';
import { OptimisticReservation } from './adapters/optimistic.reservation.js';
import { PessimisticReservation } from './adapters/pessimistic.reservation.js';
import { RedisLockReservation } from './adapters/redis-lock.reservation.js';
import type { HoldInput, HoldResult, SeatReservation } from './domain/seat-reservation.js';
import { ACTIVE_BOOKING_STATUSES } from './domain/seat-status.js';

@Injectable()
export class BookingsService {
  private readonly reservations: Record<BookingStrategy, SeatReservation>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly env: Env
  ) {
    this.reservations = {
      [BOOKING_STRATEGY.NAIVE]: new NaiveReservation(db),
      [BOOKING_STRATEGY.PESSIMISTIC]: new PessimisticReservation(db),
      [BOOKING_STRATEGY.OPTIMISTIC]: new OptimisticReservation(db),
      [BOOKING_STRATEGY.REDIS_LOCK]: new RedisLockReservation(db, redis),
    };
  }

  /** Holds the seat under the strategy of its event; NotFound when the seat is not in the event. */
  async hold(input: HoldInput): Promise<HoldResult> {
    const [event] = await this.db
      .select({ strategy: events.strategy })
      .from(seats)
      .innerJoin(events, eq(events.id, seats.eventId))
      .where(and(eq(seats.id, input.seatId), eq(seats.eventId, input.eventId)));
    if (event === undefined) throw new NotFoundException('Seat not found in this event');
    return this.reservations[event.strategy].hold({
      ...input,
      now: this.clock.now(),
      ttlSeconds: this.env.HOLD_TTL_SECONDS,
    });
  }

  /** Σ (active bookings per seat − 1) over the seats of the event. */
  async countDoubleBookings(eventId: string): Promise<number> {
    const perSeat = this.db
      .select({ n: count().as('n') })
      .from(bookings)
      .where(
        and(eq(bookings.eventId, eventId), inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]))
      )
      .groupBy(bookings.seatId)
      .as('per_seat');
    const [row] = await this.db
      .select({ doubles: sql<number>`coalesce(sum(${perSeat.n} - 1), 0)::int` })
      .from(perSeat);
    if (row === undefined) throw new Error('double-booking count returned no row');
    return row.doubles;
  }
}
