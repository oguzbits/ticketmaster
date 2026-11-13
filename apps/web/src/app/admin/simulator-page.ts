import { DecimalPipe } from '@angular/common';
import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  BOOKING_STRATEGY,
  type BookingStrategy,
  BookingStrategySchema,
  SIMULATION_LIMITS,
  SIMULATION_STATUS,
  type SimulationProgress,
  type SimulationRun,
} from '@app/shared';

import { SimulatorService } from './simulator.service';

const MESSAGE = {
  BUSY: 'Two runs are active. Try again shortly.',
  GENERIC: 'The run could not be started. Try again.',
  STREAM: 'The live view was interrupted. The run keeps going on the server.',
  FAILED: 'The run failed. Start it again; nothing was added to the comparison.',
} as const;

function messageFor(error: Error): string {
  return error instanceof HttpErrorResponse && error.status === HttpStatusCode.TooManyRequests
    ? MESSAGE.BUSY
    : MESSAGE.GENERIC;
}

/** The admin's rush simulator: start a run, watch it live, compare the finished runs. */
@Component({
  selector: 'app-simulator-page',
  imports: [DecimalPipe],
  templateUrl: './simulator-page.html',
  host: { class: 'flex flex-col gap-6' },
})
export class SimulatorPage {
  private readonly service = inject(SimulatorService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly limits = SIMULATION_LIMITS;
  protected readonly message = MESSAGE;
  protected readonly strategies = Object.values(BOOKING_STRATEGY);
  protected readonly failed = SIMULATION_STATUS.FAILED;

  protected readonly buyers = signal<number>(SIMULATION_LIMITS.BUYERS_DEFAULT);
  protected readonly seats = signal<number>(SIMULATION_LIMITS.SEATS_DEFAULT);
  protected readonly strategy = signal<BookingStrategy>(BOOKING_STRATEGY.PESSIMISTIC);

  protected readonly starting = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly run = signal<SimulationRun | null>(null);
  protected readonly progress = signal<SimulationProgress | null>(null);
  protected readonly streamProblem = signal<string | null>(null);

  /** True from the click until the stream ended; the start button stays disabled. */
  protected readonly active = computed(() => {
    if (this.starting()) return true;
    const status = this.progress()?.status;
    return (
      this.run() !== null &&
      status !== SIMULATION_STATUS.FINISHED &&
      status !== SIMULATION_STATUS.FAILED
    );
  });

  protected readonly runs = rxResource({ stream: () => this.service.list() });

  protected pickStrategy(value: string): void {
    this.strategy.set(BookingStrategySchema.parse(value));
  }

  protected start(event: Event): void {
    event.preventDefault();
    if (this.active()) return;
    this.problem.set(null);
    this.starting.set(true);
    // The form's native validation keeps the values within the limits; the service parses them too.
    this.service
      .start({ buyers: this.buyers(), seats: this.seats(), strategy: this.strategy() })
      .subscribe({
        next: (run) => {
          this.starting.set(false);
          this.run.set(run);
          this.progress.set(null);
          this.watch(run.id);
        },
        error: (error: Error) => {
          this.starting.set(false);
          this.problem.set(messageFor(error));
        },
      });
  }

  protected watch(runId: string): void {
    this.streamProblem.set(null);
    this.service
      .progress(runId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (progress) => this.progress.set(progress),
        error: () => this.streamProblem.set(MESSAGE.STREAM),
        complete: () => {
          // Only a finished run joins the comparison; the list holds finished runs only.
          if (this.progress()?.status === SIMULATION_STATUS.FINISHED) this.runs.reload();
        },
      });
  }
}
