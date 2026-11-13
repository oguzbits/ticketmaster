import { CLOCK, type Clock } from '@app/api/clock';
import { REDIS } from '@app/api/redis';
import {
  EMPTY_METRICS,
  SIMULATION_PROGRESS_TTL_SECONDS,
  SIMULATION_RUN_TIMEOUT_MS,
  simulationProgressKey,
  SimulationsService,
} from '@app/api/simulations';
import {
  SIMULATION_CONSUMER_GROUP,
  SIMULATION_STATUS,
  SIMULATION_STREAM_KEY,
  type SimulationProgress,
} from '@app/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

/** How often stale runs and stale queue entries are swept. */
const REAPER_INTERVAL_MS = 30_000;
/** Pending entries acknowledged per tick; a backlog is worked off over several ticks. */
const PENDING_BATCH = 100;

/** The Redis commands the job needs; a spec passes fakes. */
export interface ReaperRedis {
  set(key: string, value: string, options: { EX: number }): Promise<string | null>;
  xPendingRange(
    key: string,
    group: string,
    start: string,
    end: string,
    count: number,
    options: { IDLE: number }
  ): Promise<{ id: string }[]>;
  xAck(key: string, group: string, id: string | string[]): Promise<number>;
}

/**
 * Recovers what a dead worker leaves behind: runs that stay QUEUED or RUNNING past the run timeout
 * become FAILED (their progress key follows, so open streams end), and queue entries that a worker
 * read and never acknowledged are acknowledged. Both are safe after the timeout: the run of such
 * an entry is stale by then and has just been failed, and a redelivery would only be dropped.
 */
@Injectable()
export class SimulationReaperJob {
  // Public so a spec can use a stream of its own and a shorter idle time.
  streamKey: string = SIMULATION_STREAM_KEY;
  pendingIdleMs = SIMULATION_RUN_TIMEOUT_MS;
  private readonly logger = new Logger(SimulationReaperJob.name);

  constructor(
    @Inject(SimulationsService) private readonly simulations: Pick<SimulationsService, 'failStale'>,
    @Inject(REDIS) private readonly redis: ReaperRedis,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  @Interval(REAPER_INTERVAL_MS)
  async run(): Promise<void> {
    // A rejection out of a scheduled call is unhandled and would stop the worker: log it, retry next
    // tick. The two sweeps are independent, so one failing does not skip the other.
    await this.sweep('stale runs', () => this.failStaleRuns());
    await this.sweep('pending entries', () => this.ackStalePending());
  }

  private async sweep(name: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger.error(
        `simulation reaper (${name}) failed: ${error instanceof Error ? error.name : 'unknown'}`
      );
    }
  }

  private async failStaleRuns(): Promise<void> {
    const failed: SimulationProgress = { status: SIMULATION_STATUS.FAILED, metrics: EMPTY_METRICS };
    for (const runId of await this.simulations.failStale(this.clock.now())) {
      this.logger.warn(`run ${runId} marked FAILED: no result within the run timeout`);
      try {
        await this.redis.set(simulationProgressKey(runId), JSON.stringify(failed), {
          EX: SIMULATION_PROGRESS_TTL_SECONDS,
        });
      } catch (error) {
        // The row is FAILED already; the next stream that finds no key reads it from there.
        this.logger.error(
          `progress of run ${runId} not marked FAILED: ${error instanceof Error ? error.name : 'unknown'}`
        );
      }
    }
  }

  private async ackStalePending(): Promise<void> {
    const stale = await this.redis.xPendingRange(
      this.streamKey,
      SIMULATION_CONSUMER_GROUP,
      '-',
      '+',
      PENDING_BATCH,
      { IDLE: this.pendingIdleMs }
    );
    if (stale.length === 0) return;
    await this.redis.xAck(
      this.streamKey,
      SIMULATION_CONSUMER_GROUP,
      stale.map(({ id }) => id)
    );
    this.logger.warn(`acknowledged ${stale.length} stale simulation commands`);
  }
}
