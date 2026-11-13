import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { FakePaymentProvider } from './adapters/fake-payment.provider.js';
import { RedisSeatChangePublisher } from './adapters/redis-seat-changes.js';
import { SeatReservations } from './adapters/seat-reservations.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { BOOKING_PORTS, type BookingPorts } from './domain/booking-ports.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './domain/payment-provider.js';
import { SEAT_CHANGE_PUBLISHER, type SeatChangePublisher } from './domain/seat-change.js';

@Module({
  controllers: [BookingsController],
  providers: [
    BookingsService,
    {
      provide: SeatReservations,
      useFactory: (db: Database, redis: Redis, clock: Clock, env: Env) =>
        new SeatReservations(db, redis, clock, env.HOLD_TTL_SECONDS),
      inject: [DB, REDIS, CLOCK, APP_CONFIG],
    },
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (env: Env) => new FakePaymentProvider(env.PAYMENT_FAILURE_RATE),
      inject: [APP_CONFIG],
    },
    {
      provide: BOOKING_PORTS,
      useFactory: (payments: PaymentProvider, seatChanges: SeatChangePublisher): BookingPorts => ({
        payments,
        seatChanges,
      }),
      inject: [PAYMENT_PROVIDER, SEAT_CHANGE_PUBLISHER],
    },
    {
      provide: SEAT_CHANGE_PUBLISHER,
      useFactory: (redis: Redis) => new RedisSeatChangePublisher(redis),
      inject: [REDIS],
    },
  ],
  exports: [BookingsService, SEAT_CHANGE_PUBLISHER],
})
export class BookingsModule {}
