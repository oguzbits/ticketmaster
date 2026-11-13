import {
  type CreateEventRequest,
  CreateEventRequestSchema,
  type EventSummary,
  type OrganizerEvent,
  ROLE,
  type Venue,
} from '@app/shared';
import { Body, Controller, Get, Post } from '@nestjs/common';

import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator.js';
import { type AuthUser, CurrentUser, Roles } from '../auth/index.js';
import { OrganizerService } from './organizer.service.js';

@Controller()
export class OrganizerController {
  constructor(private readonly organizer: OrganizerService) {}

  @Roles(ROLE.ORGANIZER)
  @Get('venues')
  venues(): Promise<Venue[]> {
    return this.organizer.listVenues();
  }

  @Roles(ROLE.ORGANIZER)
  @Get('organizer/events')
  ownEvents(@CurrentUser() user: AuthUser): Promise<OrganizerEvent[]> {
    return this.organizer.listOwnEvents(user.id);
  }

  @Roles(ROLE.ORGANIZER)
  @RateLimit('CREATE_EVENT')
  @Post('events')
  create(
    @Body(new ZodPipe(CreateEventRequestSchema)) body: CreateEventRequest,
    @CurrentUser() user: AuthUser
  ): Promise<EventSummary> {
    return this.organizer.createEvent(body, user.id);
  }
}
