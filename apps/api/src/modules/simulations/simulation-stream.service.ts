import { randomUUID } from 'node:crypto';

import { SIMULATION_STATUS, type SimulationProgress, SimulationProgressSchema } from '@app/shared';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  catchError,
  distinctUntilChanged,
  exhaustMap,
  finalize,
  from,
  type Observable,
  takeUntil,
  takeWhile,
  throwError,
  timer,
} from 'rxjs';

import { SLOT_SLACK_MS, SlotLimiter } from '../../infrastructure/rate-limit/slot-limiter.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { EMPTY_METRICS, simulationProgressKey } from './simulation-progress.js';
import { SimulationsService } from './simulations.service.js';

/** How often a stream looks at the progress key. */
export const PROGRESS_POLL_MS = 250;
/** After this long the server ends a stream; the client reconnects and reads the current state. */
export const SIMULATION_STREAM_MAX_LIFETIME_MS = 600_000;
/** Open progress streams all API instances serve together; every stream polls Redis. */
export const MAX_SIMULATION_STREAMS = 50;

const FINAL_STATUSES: readonly string[] = [SIMULATION_STATUS.FINISHED, SIMULATION_STATUS.FAILED];

/**
 * Serves the progress of a run: polls the key the worker writes, no subscription, so there is no
 * snapshot-versus-subscribe race and it works across API instances.
 */
@Injectable()
export class SimulationStreamService {
  // Public so a spec can shorten them.
  pollMs = PROGRESS_POLL_MS;
  maxLifetimeMs = SIMULATION_STREAM_MAX_LIFETIME_MS;
  maxStreams = MAX_SIMULATION_STREAMS;
  private readonly logger = new Logger(SimulationStreamService.name);
  /** Redis key of the slot counter; a spec uses a key of its own. */
  slotKey = 'streams:simulation:total';

  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, 'get'>,
    @Inject(SimulationsService) private readonly simulations: Pick<SimulationsService, 'find'>,
    @Inject(SlotLimiter) private readonly slots: SlotLimiter
  ) {}

  /**
   * Emits when the progress changed and completes after FINISHED or FAILED. A value the worker
   * wrote that is not a progress payload ends the stream with an error, no fallback data. The cap
   * is checked here, before an Observable exists: once Nest subscribes it has sent the 200 headers.
   * The slot is taken now and given back when the stream ends, so the caller must subscribe (a
   * slot that is never given back runs out by itself after the stream lifetime).
   */
  async stream(runId: string): Promise<Observable<SimulationProgress>> {
    const slotId = randomUUID();
    const lifetimeMs = this.maxLifetimeMs + SLOT_SLACK_MS;
    if (!(await this.slots.acquire(this.slotKey, slotId, this.maxStreams, lifetimeMs))) {
      throw new ServiceUnavailableException('Too many open streams, try again later');
    }
    return timer(0, this.pollMs).pipe(
      // One read at a time: a slow read must not stack up behind the next tick.
      exhaustMap(() => from(this.read(runId))),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      takeWhile(({ status }) => !FINAL_STATUSES.includes(status), true),
      takeUntil(timer(this.maxLifetimeMs)),
      catchError((error: Error) => {
        this.logger.error(`progress stream of run ${runId} failed: ${error.name}`);
        return throwError(() => error);
      }),
      finalize(() => {
        // A slot that stays after a failed release runs out by itself.
        this.slots.release(this.slotKey, slotId).catch((error: Error) => {
          this.logger.error(`releasing a stream slot failed: ${error.name}`);
        });
      })
    );
  }

  /** The key while the worker reports; the row for a run it has not started or whose key expired. */
  private async read(runId: string): Promise<SimulationProgress> {
    const raw = await this.redis.get(simulationProgressKey(runId));
    if (raw !== null) return SimulationProgressSchema.parse(JSON.parse(raw));
    const run = await this.simulations.find(runId);
    return { status: run.status, metrics: run.metrics ?? EMPTY_METRICS };
  }
}
