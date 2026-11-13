import { OutboxService } from '@app/api/outbox';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

/** How often unpublished outbox rows are sent: a confirmed booking reaches the queue within about this. */
const OUTBOX_RELAY_INTERVAL_MS = 1000;
/** Rows per run. A send runs inside the relay's transaction, so a batch stays small. */
export const OUTBOX_RELAY_BATCH_SIZE = 20;

@Injectable()
export class OutboxRelayJob {
  private readonly logger = new Logger(OutboxRelayJob.name);
  private running = false;

  constructor(@Inject(OutboxService) private readonly outbox: OutboxService) {}

  @Interval(OUTBOX_RELAY_INTERVAL_MS)
  async run(): Promise<void> {
    // A slow queue must not pile up runs that hold locks side by side.
    if (this.running) return;
    this.running = true;
    // A rejection out of a scheduled call is unhandled and would stop the worker: log it, retry next tick.
    try {
      const { sent, failed } = await this.outbox.relay(OUTBOX_RELAY_BATCH_SIZE);
      if (failed > 0) this.logger.warn(`outbox relay: ${sent} sent, ${failed} failed, will retry`);
    } catch (error) {
      this.logger.error(`outbox relay failed: ${error instanceof Error ? error.name : 'unknown'}`);
    } finally {
      this.running = false;
    }
  }
}
