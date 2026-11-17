import { CLOCK, type Clock } from '@app/api/clock';
import { TicketsService } from '@app/api/tickets';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

/** How often stored PDFs of cancelled bookings are removed. */
const TICKET_RETENTION_INTERVAL_MS = 60_000;
/** Bookings cleaned up per tick; a backlog is worked off over several ticks. */
export const TICKET_RETENTION_BATCH = 100;

/**
 * Removes stored ticket PDFs of cancelled bookings (the download already answers 404 right after
 * cancel; this reclaims the bucket object).
 */
@Injectable()
export class TicketRetentionJob {
  private readonly logger = new Logger(TicketRetentionJob.name);

  constructor(
    @Inject(TicketsService)
    private readonly tickets: Pick<TicketsService, 'deleteCancelled'>,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  @Interval(TICKET_RETENTION_INTERVAL_MS)
  async run(): Promise<void> {
    // A rejection out of a scheduled call is unhandled and would stop the worker: log it, retry next tick.
    try {
      const deleted = await this.tickets.deleteCancelled(this.clock.now(), TICKET_RETENTION_BATCH);
      if (deleted > 0) this.logger.log(`deleted ${deleted} cancelled ticket PDFs`);
    } catch (error) {
      this.logger.error(
        `ticket retention failed: ${error instanceof Error ? error.name : 'unknown'}`
      );
    }
  }
}
