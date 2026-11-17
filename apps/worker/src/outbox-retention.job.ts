import { CLOCK, type Clock } from '@app/api/clock';
import { OutboxService } from '@app/api/outbox';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

/** How often outbox rows and idempotency records past their retention are deleted. */
const OUTBOX_RETENTION_INTERVAL_MS = 60_000;
/** Rows deleted per table per tick; a backlog of old rows is worked off over several ticks. */
export const OUTBOX_RETENTION_BATCH = 1000;

/**
 * Keeps the outbox tables bounded: a published row lives for OUTBOX_RETENTION_SECONDS, a consumer's
 * idempotency record for PROCESSED_RETENTION_SECONDS.
 */
@Injectable()
export class OutboxRetentionJob {
  private readonly logger = new Logger(OutboxRetentionJob.name);

  constructor(
    @Inject(OutboxService)
    private readonly outbox: Pick<OutboxService, 'deletePublished' | 'deleteProcessed'>,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  @Interval(OUTBOX_RETENTION_INTERVAL_MS)
  async run(): Promise<void> {
    // A rejection out of a scheduled call is unhandled and would stop the worker: log it, retry next tick.
    try {
      const now = this.clock.now();
      const published = await this.outbox.deletePublished(now, OUTBOX_RETENTION_BATCH);
      if (published > 0) this.logger.log(`deleted ${published} published outbox rows`);
      const processed = await this.outbox.deleteProcessed(now, OUTBOX_RETENTION_BATCH);
      if (processed > 0) this.logger.log(`deleted ${processed} processed message records`);
    } catch (error) {
      this.logger.error(
        `outbox retention failed: ${error instanceof Error ? error.name : 'unknown'}`
      );
    }
  }
}
