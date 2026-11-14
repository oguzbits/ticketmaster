import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { BUSINESS_METRICS, type BusinessMetrics } from '../../core/business-metrics.js';
import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { AuditModule, AuditService } from '../audit/index.js';
import { OutboxModule, OutboxService } from '../outbox/index.js';
import { WaitingRoomModule, WaitingRoomService } from '../waiting-room/index.js';
import { BOOKING_PORTS, type BookingPorts } from './adapters/booking-ports.js';
import { FakePaymentProvider } from './adapters/fake-payment.provider.js';
import { RedisSeatChangePublisher } from './adapters/redis-seat-changes.js';
import { SeatReservations } from './adapters/seat-reservations.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './domain/payment-provider.js';
import { SEAT_CHANGE_PUBLISHER, type SeatChangePublisher } from './domain/seat-change.js';

@Module({
  imports: [AuditModule, OutboxModule, WaitingRoomModule],
  controllers: [BookingsController],
  providers: [
    BookingsService,
    {
      provide: SeatReservations,
      // Four parameters is the factory limit: the TTL and the audit service travel as one object.
      useFactory: (
        ...[db, redis, clock, env, audit]: [Database, Redis, Clock, Env, AuditService]
      ) => new SeatReservations(db, redis, clock, { ttlSeconds: env.HOLD_TTL_SECONDS, audit }),
      inject: [DB, REDIS, CLOCK, APP_CONFIG, AuditService],
    },
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (env: Env) => new FakePaymentProvider(env.PAYMENT_FAILURE_RATE),
      inject: [APP_CONFIG],
    },
    {
      provide: BOOKING_PORTS,
      // One tuple parameter: the ports outgrew the four parameters a factory may take.
      useFactory: (
        ...[payments, seatChanges, outbox, waitingRoom, metrics, audit]: [
          PaymentProvider,
          SeatChangePublisher,
          OutboxService,
          WaitingRoomService,
          BusinessMetrics,
          AuditService,
        ]
      ): BookingPorts => ({ payments, seatChanges, outbox, waitingRoom, metrics, audit }),
      inject: [
        PAYMENT_PROVIDER,
        SEAT_CHANGE_PUBLISHER,
        OutboxService,
        WaitingRoomService,
        BUSINESS_METRICS,
        AuditService,
      ],
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
