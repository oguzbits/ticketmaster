import { BookingsModule } from '@app/api/bookings';
import { ClockModule } from '@app/api/clock';
import { ConfigModule } from '@app/api/config';
import { DatabaseModule } from '@app/api/database';
import { DemoModule } from '@app/api/demo';
import { MetricsModule } from '@app/api/metrics';
import { OutboxModule } from '@app/api/outbox';
import { RedisModule } from '@app/api/redis';
import { SimulationsModule } from '@app/api/simulations';
import { TicketsModule } from '@app/api/tickets';
import { WaitingRoomModule } from '@app/api/waiting-room';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';

import { DemoCleanupJob } from './demo-cleanup.job.js';
import { ConfirmationMailHandler } from './handlers/confirmation-mail.handler.js';
import { TicketPdfHandler } from './handlers/ticket-pdf.handler.js';
import { HoldExpiryJob } from './hold-expiry.job.js';
import { OperationalGauges } from './operational-gauges.js';
import { OutboxRelayJob } from './outbox-relay.job.js';
import { BOOKING_CONFIRMED_EFFECTS, QueueConsumer } from './queue-consumer.js';
import { SimulationConsumer } from './simulation.consumer.js';
import { SimulationReaperJob } from './simulation-reaper.job.js';
import { SimulationRetentionJob } from './simulation-retention.job.js';
import { WaitingRoomAdmissionJob } from './waiting-room-admission.job.js';
import { workerLogOptions } from './worker-logger.js';

@Module({
  imports: [
    LoggerModule.forRoot({ pinoHttp: workerLogOptions }),
    ScheduleModule.forRoot(),
    ConfigModule,
    ClockModule,
    MetricsModule,
    DatabaseModule,
    RedisModule,
    BookingsModule,
    DemoModule,
    OutboxModule,
    SimulationsModule,
    TicketsModule,
    WaitingRoomModule,
  ],
  providers: [
    HoldExpiryJob,
    WaitingRoomAdmissionJob,
    OutboxRelayJob,
    DemoCleanupJob,
    SimulationReaperJob,
    SimulationRetentionJob,
    SimulationConsumer,
    TicketPdfHandler,
    ConfirmationMailHandler,
    {
      provide: BOOKING_CONFIRMED_EFFECTS,
      useFactory: (ticketPdf: TicketPdfHandler, confirmationMail: ConfirmationMailHandler) => [
        ticketPdf,
        confirmationMail,
      ],
      inject: [TicketPdfHandler, ConfirmationMailHandler],
    },
    QueueConsumer,
    OperationalGauges,
  ],
})
export class WorkerModule {}
