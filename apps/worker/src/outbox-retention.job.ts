import { CLOCK, type Clock } from '@app/api/clock';
import { OutboxService } from '@app/api/outbox';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

/** How often published outbox rows past their retention are deleted. */
const OUTBOX_RETENTION_INTERVAL_MS = 60_000;
/** Rows deleted per tick; a backlog of old rows is worked off over several ticks. */
export const OUTBOX_RETENTION_BATCH = 1000;

/** Keeps the outbox table bounded: a published row lives for OUTBOX_RETENTION_SECONDS. */
@Injectable()
export class OutboxRetentionJob {
  private readonly logger = new Logger(OutboxRetentionJob.name);

  constructor(
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, 'deletePublished'>,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  @Interval(OUTBOX_RETENTION_INTERVAL_MS)
  async run(): Promise<void> {
    // A rejection out of a scheduled call is unhandled and would stop the worker: log it, retry next tick.
    try {
      const deleted = await this.outbox.deletePublished(this.clock.now(), OUTBOX_RETENTION_BATCH);
      if (deleted > 0) this.logger.log(`deleted ${deleted} published outbox rows`);
    } catch (error) {
      this.logger.error(
        `outbox retention failed: ${error instanceof Error ? error.name : 'unknown'}`
      );
    }
  }
}
