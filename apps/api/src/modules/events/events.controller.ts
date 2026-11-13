import type { EventDetail, EventSummary } from '@app/shared';
import { Controller, Get, Param } from '@nestjs/common';
import { z } from 'zod';

import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { Public } from '../auth/index.js';
import { EventsService } from './events.service.js';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Public()
  @Get()
  list(): Promise<EventSummary[]> {
    return this.events.list();
  }

  @Public()
  @Get(':id')
  detail(@Param('id', new ZodPipe(z.uuid())) id: string): Promise<EventDetail> {
    return this.events.detail(id);
  }
}
