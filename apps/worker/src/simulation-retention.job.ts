import { CLOCK, type Clock } from '@app/api/clock';
import { SimulationsService } from '@app/api/simulations';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

/** How often the sandbox events of old runs are deleted. */
const SIMULATION_RETENTION_INTERVAL_MS = 60_000;
/** Events deleted per tick: each takes its seats and up to 2000 bookings with it. */
export const SIMULATION_RETENTION_BATCH = 100;

/** Keeps the data of the rush simulator bounded: a run lives for SIMULATION_RETENTION_SECONDS. */
@Injectable()
export class SimulationRetentionJob {
  private readonly logger = new Logger(SimulationRetentionJob.name);

  constructor(
    @Inject(SimulationsService)
    private readonly simulations: Pick<SimulationsService, 'deleteFinished'>,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  @Interval(SIMULATION_RETENTION_INTERVAL_MS)
  async run(): Promise<void> {
    // A rejection out of a scheduled call is unhandled and would stop the worker: log it, retry next tick.
    try {
      const deleted = await this.simulations.deleteFinished(
        this.clock.now(),
        SIMULATION_RETENTION_BATCH
      );
      if (deleted > 0) this.logger.log(`deleted ${deleted} sandbox events of old simulation runs`);
    } catch (error) {
      this.logger.error(
        `simulation retention failed: ${error instanceof Error ? error.name : 'unknown'}`
      );
    }
  }
}
