import { Module } from '@nestjs/common';

import { BookingsService } from './bookings.service.js';

@Module({ providers: [BookingsService], exports: [BookingsService] })
export class BookingsModule {}
