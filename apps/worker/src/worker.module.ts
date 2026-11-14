import { BookingsModule } from '@app/api/bookings';
import { ClockModule } from '@app/api/clock';
import { ConfigModule } from '@app/api/config';
import { DatabaseModule } from '@app/api/database';
import { DemoModule } from '@app/api/demo';
import { OutboxModule } from '@app/api/outbox';
import { RedisModule } from '@app/api/redis';
import { SimulationsModule } from '@app/api/simulations';
import { TicketsModule } from '@app/api/tickets';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';

import { DemoCleanupJob } from './demo-cleanup.job.js';
import { ConfirmationMailHandler } from './handlers/confirmation-mail.handler.js';
import { TicketPdfHandler } from './handlers/ticket-pdf.handler.js';
import { HoldExpiryJob } from './hold-expiry.job.js';
import { OutboxRelayJob } from './outbox-relay.job.js';
import { QueueConsumer } from './queue-consumer.js';
import { SimulationConsumer } from './simulation.consumer.js';
import { SimulationReaperJob } from './simulation-reaper.job.js';
import { SimulationRetentionJob } from './simulation-retention.job.js';

@Module({
  imports: [
    LoggerModule.forRoot(),
    ScheduleModule.forRoot(),
    ConfigModule,
    ClockModule,
    DatabaseModule,
    RedisModule,
    BookingsModule,
    DemoModule,
    OutboxModule,
    SimulationsModule,
    TicketsModule,
  ],
  providers: [
    HoldExpiryJob,
    OutboxRelayJob,
    DemoCleanupJob,
    SimulationReaperJob,
    SimulationRetentionJob,
    SimulationConsumer,
    TicketPdfHandler,
    ConfirmationMailHandler,
    QueueConsumer,
  ],
})
export class WorkerModule {}
