import { ROLE, type TicketDownload } from '@app/shared';
import { Controller, Get, Param } from '@nestjs/common';
import { z } from 'zod';

import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { type AuthUser, CurrentUser, Roles } from '../auth/index.js';
import { TicketsService } from './tickets.service.js';

/** The user is the one in the verified token; the booking ID alone never grants access. */
@Controller('bookings')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Roles(ROLE.CUSTOMER)
  @Get(':id/ticket')
  download(
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @CurrentUser() user: AuthUser
  ): Promise<TicketDownload> {
    return this.tickets.downloadUrl(user.id, id);
  }
}
