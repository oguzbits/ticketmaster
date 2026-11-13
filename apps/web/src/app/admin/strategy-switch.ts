import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { Component, inject, input, linkedSignal, output, signal } from '@angular/core';
import { BOOKING_STRATEGY, type BookingStrategy, BookingStrategySchema } from '@app/shared';

import { EventsService } from '../events/events.service';

const MESSAGE = {
  NOT_ALLOWED: 'Not allowed for this event. Your account may not switch its strategy.',
  TOO_MANY: 'Too many requests. Wait a moment and try again.',
  REJECTED: 'The server rejected that strategy.',
  GENERIC: 'The strategy could not be switched. Try again.',
} as const;

function messageFor(error: Error): string {
  switch (error instanceof HttpErrorResponse ? error.status : 0) {
    case HttpStatusCode.NotFound:
      return MESSAGE.NOT_ALLOWED;
    case HttpStatusCode.TooManyRequests:
      return MESSAGE.TOO_MANY;
    case HttpStatusCode.BadRequest:
      return MESSAGE.REJECTED;
    default:
      return MESSAGE.GENERIC;
  }
}

/** The admin's strategy switch of one event. The server decides who may switch which event. */
@Component({
  selector: 'app-strategy-switch',
  templateUrl: './strategy-switch.html',
  host: { class: 'flex flex-col gap-3 rounded border border-edge bg-surface-raised p-4' },
})
export class StrategySwitch {
  private readonly events = inject(EventsService);

  readonly eventId = input.required<string>();
  /** The strategy the event has now; the parent updates it after `switched`. */
  readonly strategy = input.required<BookingStrategy>();
  readonly switched = output<BookingStrategy>();

  protected readonly strategies = Object.values(BOOKING_STRATEGY);
  protected readonly choice = linkedSignal(() => this.strategy());
  protected readonly confirming = signal(false);
  protected readonly pending = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly done = signal<BookingStrategy | null>(null);

  protected choose(value: string): void {
    this.choice.set(BookingStrategySchema.parse(value));
  }

  protected ask(): void {
    this.done.set(null);
    this.confirming.set(true);
  }

  protected cancel(): void {
    if (this.pending()) return;
    this.confirming.set(false);
    this.problem.set(null);
    this.choice.set(this.strategy());
  }

  protected confirm(): void {
    if (this.pending()) return;
    this.pending.set(true);
    this.problem.set(null);
    this.events.setStrategy(this.eventId(), this.choice()).subscribe({
      next: (summary) => {
        this.pending.set(false);
        this.confirming.set(false);
        this.done.set(summary.strategy);
        this.switched.emit(summary.strategy);
      },
      error: (error: Error) => {
        this.pending.set(false);
        this.problem.set(messageFor(error));
      },
    });
  }
}
