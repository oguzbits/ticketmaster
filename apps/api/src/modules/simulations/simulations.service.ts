import {
  SIMULATION_STATUS,
  SIMULATION_STREAM_KEY,
  type SimulationMetrics,
  type SimulationRun,
  type StartSimulationRequest,
} from '@app/shared';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { events, seats, simulationRuns, venues } from '../../infrastructure/database/schema.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';

/** A run that is QUEUED or RUNNING for longer than this no longer counts as active (a dead worker). */
export const SIMULATION_RUN_TIMEOUT_MS = 600_000;
/** Runs that may be active at once; every run keeps the worker's database pool busy. */
export const MAX_ACTIVE_RUNS = 2;
/** Finished runs the comparison lists. */
export const MAX_LISTED_RUNS = 20;

const ACTIVE_STATUSES = [SIMULATION_STATUS.QUEUED, SIMULATION_STATUS.RUNNING];
const SANDBOX_SECTION = 'SIM';
const SEATS_PER_ROW = 20;
const SANDBOX_SEAT_PRICE_CENTS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Serializes the cap check of all starts, so parallel requests cannot all pass it. */
const START_LOCK_KEY = 'simulation-start';

/** The one Redis command `start` needs; a spec passes a failing one. */
export interface QueueWriter {
  xAdd(key: string, id: string, message: Record<string, string>): Promise<string>;
}

export interface ClaimedRun {
  eventId: string;
  buyers: number;
  seatIds: string[];
  /** The admin who started the run; the buyers book as this user, see `SimulationRunner`. */
  startedBy: string;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type RunRow = typeof simulationRuns.$inferSelect;

function toRun(row: RunRow): SimulationRun {
  return {
    id: row.id,
    eventId: row.eventId,
    strategy: row.strategy,
    buyers: row.buyers,
    seats: row.seats,
    status: row.status,
    metrics: row.metrics,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class SimulationsService {
  // Public so a spec can use a stream of its own.
  streamKey: string = SIMULATION_STREAM_KEY;
  private readonly logger = new Logger(SimulationsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly queue: QueueWriter,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * One transaction under an advisory lock: the cap check, a fresh sandbox event of the admin with
   * `seats` generated seats and the QUEUED run. The command goes onto the stream after the commit,
   * so the worker never reads a run it cannot see; when that fails the run is marked FAILED.
   */
  async start(input: StartSimulationRequest, adminId: string): Promise<SimulationRun> {
    const run = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${START_LOCK_KEY}))`);
      // Read under the lock: a reading from before it could miss runs that committed meanwhile.
      const now = this.clock.now();
      await this.assertBelowCap(tx, now);
      const [venue] = await tx.select({ id: venues.id }).from(venues).orderBy(venues.name).limit(1);
      if (venue === undefined) throw new Error('a simulation needs a venue, none exists');
      const [event] = await tx
        .insert(events)
        .values({
          venueId: venue.id,
          name: `Rush ${input.strategy} ${input.buyers} buyers`,
          startsAt: new Date(now.getTime() + DAY_MS),
          strategy: input.strategy,
          ownerId: adminId,
          // Private to the admin, so the event never shows in the public list.
          sandboxUserId: adminId,
        })
        .returning({ id: events.id });
      if (event === undefined) throw new Error('event insert returned no row');
      await tx.execute(sql`
        insert into ${seats} (event_id, section, row, number, price_cents)
        select ${event.id}::uuid, ${SANDBOX_SECTION}, (n - 1) / ${SEATS_PER_ROW} + 1,
          (n - 1) % ${SEATS_PER_ROW} + 1, ${SANDBOX_SEAT_PRICE_CENTS}
        from generate_series(1, ${input.seats}::int) as n
      `);
      const [row] = await tx
        .insert(simulationRuns)
        .values({
          eventId: event.id,
          strategy: input.strategy,
          buyers: input.buyers,
          seats: input.seats,
          status: SIMULATION_STATUS.QUEUED,
          startedBy: adminId,
          startedAt: now,
        })
        .returning();
      if (row === undefined) throw new Error('run insert returned no row');
      return toRun(row);
    });
    try {
      await this.queue.xAdd(this.streamKey, '*', { runId: run.id });
    } catch (error) {
      // The queue error is the one to report; a failing `fail` must not hide it.
      await this.fail(run.id).catch((cause: Error) =>
        this.logger.error(`run ${run.id} not marked FAILED: ${cause.name}`)
      );
      throw error;
    }
    return run;
  }

  /** Counts the active runs that started within the timeout up to now; refuses with 429 at the cap. */
  private async assertBelowCap(tx: Tx, now: Date): Promise<void> {
    const [active] = await tx
      .select({ total: count() })
      .from(simulationRuns)
      .where(
        and(
          inArray(simulationRuns.status, ACTIVE_STATUSES),
          gte(simulationRuns.startedAt, new Date(now.getTime() - SIMULATION_RUN_TIMEOUT_MS))
        )
      );
    if ((active?.total ?? 0) >= MAX_ACTIVE_RUNS) {
      throw new HttpException(
        'Two simulation runs are active, try again shortly',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  async find(id: string): Promise<SimulationRun> {
    const [row] = await this.db.select().from(simulationRuns).where(eq(simulationRuns.id, id));
    if (row === undefined) throw new NotFoundException('Simulation run not found');
    return toRun(row);
  }

  /** The latest finished runs, newest first: the strategy comparison. */
  async listFinished(): Promise<SimulationRun[]> {
    const rows = await this.db
      .select()
      .from(simulationRuns)
      .where(eq(simulationRuns.status, SIMULATION_STATUS.FINISHED))
      .orderBy(desc(simulationRuns.finishedAt))
      .limit(MAX_LISTED_RUNS);
    return rows.map(toRun);
  }

  /**
   * The worker's first step: QUEUED to RUNNING, once. Undefined for an unknown run and for a run
   * that already started (a message that is delivered twice), so a run never executes twice.
   */
  async claim(runId: string): Promise<ClaimedRun | undefined> {
    const [row] = await this.db
      .update(simulationRuns)
      .set({ status: SIMULATION_STATUS.RUNNING })
      .where(and(eq(simulationRuns.id, runId), eq(simulationRuns.status, SIMULATION_STATUS.QUEUED)))
      .returning();
    if (row === undefined) return undefined;
    const seatRows = await this.db
      .select({ id: seats.id })
      .from(seats)
      .where(eq(seats.eventId, row.eventId));
    return {
      eventId: row.eventId,
      buyers: row.buyers,
      seatIds: seatRows.map(({ id }) => id),
      startedBy: row.startedBy,
    };
  }

  async finish(runId: string, metrics: SimulationMetrics): Promise<void> {
    await this.db
      .update(simulationRuns)
      .set({
        status: SIMULATION_STATUS.FINISHED,
        metrics,
        finishedAt: this.clock.now(),
      })
      .where(eq(simulationRuns.id, runId));
  }

  /** Only an active run can fail; a run that finished keeps its result. */
  async fail(runId: string): Promise<void> {
    await this.db
      .update(simulationRuns)
      .set({ status: SIMULATION_STATUS.FAILED, finishedAt: this.clock.now() })
      .where(and(eq(simulationRuns.id, runId), inArray(simulationRuns.status, ACTIVE_STATUSES)));
  }
}
