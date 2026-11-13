import { Controller, Param, Req, Sse } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { z } from 'zod';

import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { rateLimitAddress } from '../../infrastructure/rate-limit/rate-limit.guard.js';
import { type AuthUser, OptionalUser, Public } from '../auth/index.js';
import { EventsService } from './events.service.js';
import { type SeatStreamMessage, SeatStreamService } from './seat-stream.service.js';

/** The part of the HTTP request the route reads: the last proxy hop, see `configureApp`. */
interface ClientRequest {
  ip?: string;
}

@Controller('events')
export class SeatStreamController {
  constructor(
    private readonly events: EventsService,
    private readonly seatStream: SeatStreamService
  ) {}

  /** Public like the events routes; a token that is sent unlocks the caller's own sandbox events. */
  @Public()
  @Sse(':id/seats/stream')
  async stream(
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @OptionalUser() user: AuthUser | null,
    @Req() { ip }: ClientRequest
  ): Promise<Observable<SeatStreamMessage>> {
    if (ip === undefined) throw new Error('The request has no client address');
    // Nest sends the 200 headers as soon as it subscribes, so an event the caller may not see has
    // to fail here, before the stream exists.
    await this.events.assertVisible(id, user?.id ?? null);
    return this.seatStream.stream(id, user?.id ?? null, rateLimitAddress(ip));
  }
}
