import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { Component, inject, linkedSignal, output, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import {
  BOOKING_STRATEGY,
  type BookingStrategy,
  BookingStrategySchema,
  type EventSummary,
  MAX_ADMISSION_CAPACITY,
  WaitingRoomCapacitySchema,
} from '@app/shared';

import { OrganizerService } from './organizer.service';

const MESSAGE = {
  NAME: 'Enter a name for the event.',
  CAPACITY: `The waiting room capacity must be a whole number between 1 and ${MAX_ADMISSION_CAPACITY}, or empty for no waiting room.`,
  FUTURE: 'Pick a start time in the future.',
  LIMIT: 'The event limit for this account is reached, so no more events can be created.',
  TOO_MANY: 'Too many requests. Wait a moment and try again.',
  REJECTED:
    'The server rejected these details. Check the name and pick a start time in the future.',
  NO_VENUE: 'That venue no longer exists. Reload the page and pick another venue.',
  GENERIC: 'The event could not be created. Try again.',
} as const;

const STRATEGIES = Object.values(BOOKING_STRATEGY);

function messageFor(error: Error): string {
  switch (error instanceof HttpErrorResponse ? error.status : 0) {
    case HttpStatusCode.Conflict:
      return MESSAGE.LIMIT;
    case HttpStatusCode.TooManyRequests:
      return MESSAGE.TOO_MANY;
    case HttpStatusCode.BadRequest:
      return MESSAGE.REJECTED;
    case HttpStatusCode.NotFound:
      return MESSAGE.NO_VENUE;
    default:
      return MESSAGE.GENERIC;
  }
}

/** The create form of the organizer: the venue list loads first, then the form appears. */
@Component({
  selector: 'app-event-form',
  templateUrl: './event-form.html',
  host: { class: 'flex flex-col gap-3' },
})
export class EventForm {
  private readonly service = inject(OrganizerService);

  readonly created = output<EventSummary>();

  protected readonly venues = rxResource({ stream: () => this.service.venues() });
  protected readonly strategies = STRATEGIES;

  protected readonly venueId = linkedSignal(() => this.venues.value()?.[0]?.id ?? '');
  protected readonly name = signal('');
  protected readonly startsAt = signal('');
  protected readonly strategy = signal<BookingStrategy>(BOOKING_STRATEGY.PESSIMISTIC);
  protected readonly capacity = signal('');

  protected readonly pending = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly done = signal(false);

  protected pickStrategy(value: string): void {
    this.strategy.set(BookingStrategySchema.parse(value));
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.pending()) return;
    this.done.set(false);
    const name = this.name().trim();
    // The input holds a local time without zone; `Date` reads it as local time.
    const start = new Date(this.startsAt());
    if (name === '') {
      this.problem.set(MESSAGE.NAME);
      return;
    }
    if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) {
      this.problem.set(MESSAGE.FUTURE);
      return;
    }
    // Empty means no waiting room; `Number('')` would read as 0.
    const capacityText = this.capacity().trim();
    const capacity =
      capacityText === '' ? null : WaitingRoomCapacitySchema.safeParse(Number(capacityText));
    if (capacity !== null && !capacity.success) {
      this.problem.set(MESSAGE.CAPACITY);
      return;
    }
    this.problem.set(null);
    this.pending.set(true);
    this.service
      .create({
        venueId: this.venueId(),
        name,
        startsAt: start.toISOString(),
        strategy: this.strategy(),
        waitingRoomCapacity: capacity?.data ?? null,
      })
      .subscribe({
        next: (summary) => {
          this.pending.set(false);
          this.done.set(true);
          this.name.set('');
          this.created.emit(summary);
        },
        error: (error: Error) => {
          this.pending.set(false);
          this.problem.set(messageFor(error));
        },
      });
  }
}
