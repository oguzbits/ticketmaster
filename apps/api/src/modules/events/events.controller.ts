import {
  type EventDetail,
  type EventListQuery,
  EventListQuerySchema,
  type EventListResponse,
  type EventSummary,
  ROLE,
  type SetStrategyRequest,
  SetStrategyRequestSchema,
} from '@app/shared';
import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { z } from 'zod';

import { RequestId } from '../../infrastructure/http/request-id.decorator.js';
import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { type AuthUser, CurrentUser, OptionalUser, Public, Roles } from '../auth/index.js';
import { EventsService } from './events.service.js';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Public()
  @Get()
  list(
    @Query(new ZodPipe(EventListQuerySchema)) query: EventListQuery,
    @OptionalUser() user: AuthUser | null
  ): Promise<EventListResponse> {
    return this.events.list(user?.id ?? null, query);
  }

  @Public()
  @Get(':id')
  detail(
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @OptionalUser() user: AuthUser | null
  ): Promise<EventDetail> {
    return this.events.detail(id, user?.id ?? null);
  }

  @Roles(ROLE.ADMIN)
  @Patch(':id/strategy')
  setStrategy(
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @Body(new ZodPipe(SetStrategyRequestSchema)) body: SetStrategyRequest,
    @CurrentUser() user: AuthUser,
    @RequestId() requestId: string
  ): Promise<EventSummary> {
    return this.events.setStrategy(id, body.strategy, user.id, requestId);
  }
}
