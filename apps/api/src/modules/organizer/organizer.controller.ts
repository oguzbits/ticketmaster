import { type OrganizerEvent, ROLE, type Venue } from '@app/shared';
import { Controller, Get } from '@nestjs/common';

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
}
