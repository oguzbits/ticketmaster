import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { ConfigModule } from './config/config.module.js';
import { ClockModule } from './infrastructure/clock/clock.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { httpLogOptions } from './infrastructure/logging/http-log.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { BookingsModule } from './modules/bookings/index.js';
import { EventsModule } from './modules/events/index.js';
import { HealthModule } from './modules/health/index.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: httpLogOptions,
    }),
    ConfigModule,
    ClockModule,
    DatabaseModule,
    RedisModule,
    HealthModule,
    BookingsModule,
    EventsModule,
  ],
})
export class AppModule {}
