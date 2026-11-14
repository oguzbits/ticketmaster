import {
  type EventSummary,
  ROLE,
  type SetWaitingRoomRequest,
  SetWaitingRoomRequestSchema,
  type WaitingRoomStatus,
} from '@app/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  type MessageEvent,
  Param,
  Post,
  Put,
  Sse,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { z } from 'zod';

import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { type AuthUser, CurrentUser, Roles } from '../auth/index.js';
import { WaitingRoomService } from './waiting-room.service.js';
import { WaitingRoomStreamService } from './waiting-room-stream.service.js';

@Controller('events/:id/waiting-room')
export class WaitingRoomController {
  constructor(
    private readonly waitingRoom: WaitingRoomService,
    private readonly places: WaitingRoomStreamService
  ) {}

  @Roles(ROLE.CUSTOMER)
  @Post()
  @HttpCode(HttpStatus.OK)
  join(
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @CurrentUser() user: AuthUser
  ): Promise<WaitingRoomStatus> {
    return this.waitingRoom.join(id, user.id);
  }

  @Roles(ROLE.CUSTOMER)
  @Get()
  status(
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @CurrentUser() user: AuthUser
  ): Promise<WaitingRoomStatus> {
    return this.waitingRoom.status(id, user.id);
  }

  @Roles(ROLE.CUSTOMER)
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  leave(
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @CurrentUser() user: AuthUser
  ): Promise<void> {
    return this.waitingRoom.leave(id, user.id);
  }

  @Roles(ROLE.CUSTOMER)
  @Sse('stream')
  async stream(
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @CurrentUser() user: AuthUser
  ): Promise<Observable<MessageEvent>> {
    // Nest sends the 200 headers as soon as it subscribes, so the 503 has to come before.
    return (await this.places.stream(id, user.id)).pipe(map((data) => ({ data })));
  }

  @Roles(ROLE.ORGANIZER, ROLE.ADMIN)
  @Put('settings')
  settings(
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @Body(new ZodPipe(SetWaitingRoomRequestSchema)) body: SetWaitingRoomRequest,
    @CurrentUser() user: AuthUser
  ): Promise<EventSummary> {
    return this.waitingRoom.setCapacity(id, body.capacity, user);
  }
}
