import { CLOCK, type Clock } from '@app/api/clock';
import { DemoService } from '@app/api/demo';
import { TICKET_STORE, type TicketStore } from '@app/api/tickets';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

/** How often expired demo users are deleted. */
const DEMO_CLEANUP_INTERVAL_MS = 60_000;

@Injectable()
export class DemoCleanupJob {
  private readonly logger = new Logger(DemoCleanupJob.name);

  constructor(
    @Inject(DemoService) private readonly demo: DemoService,
    @Inject(TICKET_STORE) private readonly ticketStore: TicketStore,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  @Interval(DEMO_CLEANUP_INTERVAL_MS)
  async run(): Promise<void> {
    // A rejection out of a scheduled call is unhandled and would stop the worker: log it, retry next tick.
    try {
      const cleaned = await this.demo.deleteExpired(this.clock.now(), (bookingId) =>
        this.ticketStore.delete(bookingId)
      );
      if (cleaned > 0) this.logger.log(`deleted ${cleaned} expired demo users`);
    } catch (error) {
      this.logger.error(`demo cleanup failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  }
}
