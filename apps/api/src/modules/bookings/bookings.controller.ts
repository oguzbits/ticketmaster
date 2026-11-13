import {
  type Booking,
  type HoldRequest,
  HoldRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  ROLE,
} from '@app/shared';
import {
  Body,
  ConflictException,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { type AuthUser, CurrentUser, Roles } from '../auth/index.js';
import { BookingsService } from './bookings.service.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';

const BookingId = new ZodPipe(z.uuid());

/** Nest does not run pipes on `@Headers()`, so the header is read by a custom decorator, which it does. */
const IdempotencyKey = createParamDecorator(
  (_data: undefined, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers[
      IDEMPOTENCY_KEY_HEADER
    ]
);

/** The user is always the one in the verified token; no route takes a user ID from the client. */
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Roles(ROLE.CUSTOMER)
  @Post()
  async hold(
    @Body(new ZodPipe(HoldRequestSchema)) body: HoldRequest,
    @CurrentUser() user: AuthUser
  ): Promise<Booking> {
    const result = await this.bookings.hold({ ...body, userId: user.id });
    if (result.outcome !== HOLD_OUTCOME.PLACED)
      throw new ConflictException('Seat is not available');
    return this.bookings.getOwn(result.bookingId, user.id);
  }

  @Roles(ROLE.CUSTOMER)
  @Post(':id/payment')
  @HttpCode(HttpStatus.OK)
  async pay(
    @Param('id', BookingId) id: string,
    @IdempotencyKey(undefined, new ZodPipe(IdempotencyKeySchema)) idempotencyKey: string,
    @CurrentUser() user: AuthUser
  ): Promise<Booking> {
    await this.bookings.pay({ bookingId: id, userId: user.id, idempotencyKey });
    return this.bookings.getOwn(id, user.id);
  }

  @Roles(ROLE.CUSTOMER)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', BookingId) id: string,
    @CurrentUser() user: AuthUser
  ): Promise<Booking> {
    await this.bookings.cancel({ bookingId: id, userId: user.id });
    return this.bookings.getOwn(id, user.id);
  }

  @Roles(ROLE.CUSTOMER)
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<Booking[]> {
    return this.bookings.listOwn(user.id);
  }
}
