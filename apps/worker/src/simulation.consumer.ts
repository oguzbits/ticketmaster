import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { REDIS, type Redis } from '@app/api/redis';
import {
  type ClaimedRun,
  EMPTY_METRICS,
  SIMULATION_CONCURRENCY,
  SIMULATION_PROGRESS_TTL_SECONDS,
  simulationProgressKey,
  SimulationRunner,
  SimulationsService,
} from '@app/api/simulations';
import {
  SIMULATION_CONSUMER_GROUP,
  SIMULATION_STATUS,
  SIMULATION_STREAM_KEY,
  SimulationCommandSchema,
  type SimulationMetrics,
  type SimulationStatus,
} from '@app/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

/** How long a read waits for a command; also the longest a stopped consumer could linger. */
const BLOCK_MS = 5000;
/** The pause after a failing iteration, so a Redis that is down is not hammered. */
const ERROR_PAUSE_MS = 1000;

/**
 * Reads the start commands of the simulator from a Redis stream through a consumer group and runs
 * them, one at a time per worker. The blocking read has a connection of its own, a connection that
 * waits can do nothing else.
 */
@Injectable()
export class SimulationConsumer implements OnModuleInit, OnModuleDestroy {
  // Public so a spec can use a stream of its own and shorter waits.
  streamKey: string = SIMULATION_STREAM_KEY;
  blockMs = BLOCK_MS;
  errorPauseMs = ERROR_PAUSE_MS;
  private readonly group = SIMULATION_CONSUMER_GROUP;
  private readonly name = `worker-${randomUUID()}`;
  private readonly logger = new Logger(SimulationConsumer.name);
  private readonly reader: Redis;
  private stopping = false;
  private loop: Promise<void> = Promise.resolve();

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(SimulationsService) private readonly simulations: SimulationsService,
    @Inject(SimulationRunner) private readonly runner: SimulationRunner
  ) {
    this.reader = redis.duplicate();
  }

  async onModuleInit(): Promise<void> {
    // node-redis reconnects by itself; without a listener an 'error' event would crash the process.
    this.reader.on('error', (error: Error) =>
      this.logger.error(`simulation reader connection: ${error.name}`)
    );
    await this.reader.connect();
    await this.createGroup();
    this.loop = this.consume();
  }

  /** Ends the loop and the waiting read; a run that is going finishes first. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    // quit() would wait behind the blocking read; destroy() ends it at once.
    if (this.reader.isOpen) this.reader.destroy();
    await this.loop;
  }

  /**
   * From the start of the stream (id `0`), so a command written before the group existed, or after
   * a Redis that lost its data, is still read. A command of a settled run is dropped and
   * acknowledged by `handle`, so reading old entries is harmless.
   */
  private async createGroup(): Promise<void> {
    try {
      await this.redis.xGroupCreate(this.streamKey, this.group, '0', { MKSTREAM: true });
    } catch (error) {
      // The group of an earlier start (or another worker) is the one to use.
      if (!(error instanceof Error && error.message.includes('BUSYGROUP'))) throw error;
    }
  }

  private async consume(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.next();
      } catch (error) {
        if (this.stopping) return;
        this.logger.error(
          `simulation consumer failed, retrying: ${error instanceof Error ? error.name : 'unknown'}`
        );
        await sleep(this.errorPauseMs);
        // A Redis that lost its data has no group any more.
        await this.createGroup().catch((cause: Error) =>
          this.logger.error(`simulation group not created: ${cause.name}`)
        );
      }
    }
  }

  private async next(): Promise<void> {
    const reply = await this.reader.xReadGroup(
      this.group,
      this.name,
      { key: this.streamKey, id: '>' },
      { COUNT: 1, BLOCK: this.blockMs }
    );
    const entry = reply?.[0]?.messages[0];
    if (entry === undefined) return;
    await this.handle(entry.id, entry.message);
    // Every command is acknowledged once handled, also a malformed one: no poison loop. A command
    // whose handling threw (the database or Redis is down) stays pending until the reaper job
    // acknowledges it after the run timeout.
    await this.redis.xAck(this.streamKey, this.group, entry.id);
  }

  private async handle(entryId: string, message: Record<string, string>): Promise<void> {
    const command = SimulationCommandSchema.safeParse(message);
    if (!command.success) {
      this.logger.warn(`dropped a malformed simulation command ${entryId}`);
      return;
    }
    const { runId } = command.data;
    const run = await this.simulations.claim(runId);
    if (run === undefined) {
      this.logger.warn(`dropped command ${entryId}: run ${runId} is unknown or already started`);
      return;
    }
    await this.execute(runId, run);
  }

  /**
   * Runs the buyers and stores the result. A run that fails, or whose result cannot be stored, is
   * marked FAILED, so it never stays RUNNING; the progress key follows the row, never the other way.
   */
  private async execute(runId: string, run: ClaimedRun): Promise<void> {
    let last: SimulationMetrics = EMPTY_METRICS;
    let metrics: SimulationMetrics;
    let stored: boolean;
    try {
      metrics = await this.runner.run({
        runId,
        eventId: run.eventId,
        buyers: run.buyers,
        seats: run.seatIds,
        concurrency: SIMULATION_CONCURRENCY,
        buyerId: run.startedBy,
        onProgress: (progress) => {
          last = progress;
          this.report(runId, SIMULATION_STATUS.RUNNING, progress).catch((error: Error) =>
            this.logger.error(`progress of run ${runId} not written: ${error.name}`)
          );
        },
      });
      stored = await this.simulations.finish(runId, metrics);
    } catch (error) {
      this.logger.error(`run ${runId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
      await this.markFailed(runId, last);
      return;
    }
    if (!stored) {
      this.logger.warn(`run ${runId} was failed before its result arrived; the result is dropped`);
      return;
    }
    // The row says FINISHED: a Redis that fails now must not turn the run into FAILED.
    await this.report(runId, SIMULATION_STATUS.FINISHED, metrics).catch((error: Error) =>
      this.logger.error(`final progress of run ${runId} not written: ${error.name}`)
    );
  }

  /** Never throws: the command is acknowledged either way, a run that cannot be marked is logged. */
  private async markFailed(runId: string, last: SimulationMetrics): Promise<void> {
    try {
      await this.simulations.fail(runId);
      await this.report(runId, SIMULATION_STATUS.FAILED, last);
    } catch (error) {
      this.logger.error(
        `run ${runId} not marked FAILED: ${error instanceof Error ? error.name : 'unknown'}`
      );
    }
  }

  private async report(
    runId: string,
    status: SimulationStatus,
    metrics: SimulationMetrics
  ): Promise<void> {
    await this.redis.set(simulationProgressKey(runId), JSON.stringify({ status, metrics }), {
      EX: SIMULATION_PROGRESS_TTL_SECONDS,
    });
  }
}
