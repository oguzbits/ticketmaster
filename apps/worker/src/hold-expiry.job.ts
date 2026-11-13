import { BookingsService } from '@app/api/bookings';
import { CLOCK, type Clock } from '@app/api/clock';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

/** How often holds that ran out are released. A hold stays blocked at most this long past its expiry. */
const HOLD_EXPIRY_INTERVAL_MS = 2000;

@Injectable()
export class HoldExpiryJob {
  private readonly logger = new Logger(HoldExpiryJob.name);

  constructor(
    @Inject(BookingsService) private readonly bookings: BookingsService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  @Interval(HOLD_EXPIRY_INTERVAL_MS)
  async run(): Promise<void> {
    const expired = await this.bookings.expireHolds(this.clock.now());
    if (expired > 0) this.logger.log(`expired ${expired} holds`);
  }
}
