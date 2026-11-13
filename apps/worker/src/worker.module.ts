import { BookingsModule } from '@app/api/bookings';
import { ClockModule } from '@app/api/clock';
import { ConfigModule } from '@app/api/config';
import { DatabaseModule } from '@app/api/database';
import { RedisModule } from '@app/api/redis';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';

import { HoldExpiryJob } from './hold-expiry.job.js';

@Module({
  imports: [
    LoggerModule.forRoot(),
    ScheduleModule.forRoot(),
    ConfigModule,
    ClockModule,
    DatabaseModule,
    RedisModule,
    BookingsModule,
  ],
  providers: [HoldExpiryJob],
})
export class WorkerModule {}
