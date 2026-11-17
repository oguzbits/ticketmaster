import { BookingsService } from '@app/api/bookings';
import { CLOCK, type Clock } from '@app/api/clock';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

/** How often stranded payment attempts and failed late refunds are reconciled. */
const PAYMENT_RECONCILE_INTERVAL_MS = 30_000;

@Injectable()
export class PaymentReconciliationJob {
  private readonly logger = new Logger(PaymentReconciliationJob.name);
  private running = false;

  constructor(
    @Inject(BookingsService) private readonly bookings: BookingsService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  @Interval(PAYMENT_RECONCILE_INTERVAL_MS)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { settled, refunded, released } = await this.bookings.reconcilePayments(
        this.clock.now()
      );
      if (settled > 0 || refunded > 0 || released > 0) {
        this.logger.log(
          `reconciled payments: settled=${settled}, refunded=${refunded}, released=${released}`
        );
      }
    } catch (error) {
      this.logger.error(
        `payment reconciliation failed: ${error instanceof Error ? error.name : 'unknown'}`
      );
    } finally {
      this.running = false;
    }
  }
}
