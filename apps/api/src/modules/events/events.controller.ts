import type { EventDetail, EventSummary } from '@app/shared';
import { Controller, Get, Param } from '@nestjs/common';
import { z } from 'zod';

import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { type AuthUser, OptionalUser, Public } from '../auth/index.js';
import { EventsService } from './events.service.js';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Public()
  @Get()
  list(@OptionalUser() user: AuthUser | null): Promise<EventSummary[]> {
    return this.events.list(user?.id ?? null);
  }

  @Public()
  @Get(':id')
  detail(
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @OptionalUser() user: AuthUser | null
  ): Promise<EventDetail> {
    return this.events.detail(id, user?.id ?? null);
  }
}
