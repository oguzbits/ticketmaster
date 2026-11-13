import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { ConfigModule } from './config/config.module.js';
import { ClockModule } from './infrastructure/clock/clock.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { httpLogOptions } from './infrastructure/logging/http-log.js';
import { RateLimitGuard } from './infrastructure/rate-limit/rate-limit.guard.js';
import { RateLimitModule } from './infrastructure/rate-limit/rate-limit.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { AUTH_GUARD_PROVIDERS, AuthModule } from './modules/auth/index.js';
import { BookingsModule } from './modules/bookings/index.js';
import { DemoModule } from './modules/demo/index.js';
import { EventsModule } from './modules/events/index.js';
import { HealthModule } from './modules/health/index.js';
import { OrganizerModule } from './modules/organizer/index.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: httpLogOptions,
    }),
    ConfigModule,
    ClockModule,
    DatabaseModule,
    RedisModule,
    RateLimitModule,
    AuthModule,
    HealthModule,
    BookingsModule,
    EventsModule,
    OrganizerModule,
    DemoModule,
  ],
  // Order matters: token first, then roles, then the rate limit (it reads the user the token guard
  // attached). Every global guard is listed here, in one place, because Nest runs them in the
  // order of this list.
  providers: [...AUTH_GUARD_PROVIDERS, { provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
