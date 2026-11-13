import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { FakePaymentProvider } from './adapters/fake-payment.provider.js';
import { SeatReservations } from './adapters/seat-reservations.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { PAYMENT_PROVIDER } from './domain/payment-provider.js';

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
      // Math.random belongs here, in the adapter wiring: the domain stays deterministic.
      useFactory: (env: Env) => new FakePaymentProvider(env.PAYMENT_FAILURE_RATE, Math.random),
      inject: [APP_CONFIG],
    },
  ],
  exports: [BookingsService],
})
export class BookingsModule {}
