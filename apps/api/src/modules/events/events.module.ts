import { Module } from '@nestjs/common';

import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { AuditModule } from '../audit/index.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';
import { SeatStreamController } from './seat-stream.controller.js';
import { SeatStreamService } from './seat-stream.service.js';

@Module({
  imports: [AuditModule, RateLimitModule],
  controllers: [EventsController, SeatStreamController],
  providers: [EventsService, SeatStreamService],
})
export class EventsModule {}
