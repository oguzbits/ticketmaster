import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { ConfigModule } from './config/config.module.js';
import { ClockModule } from './infrastructure/clock/clock.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { requestId } from './infrastructure/logging/request-id.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { BookingsModule } from './modules/bookings/index.js';
import { HealthModule } from './modules/health/index.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        genReqId: requestId,
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    ConfigModule,
    ClockModule,
    DatabaseModule,
    RedisModule,
    HealthModule,
    BookingsModule,
  ],
})
export class AppModule {}
