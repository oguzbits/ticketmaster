import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { MAX_ADMISSION_CAPACITY, WaitingRoomCapacitySchema } from '@app/shared';

import { EventsService } from './events.service';

const PROBLEM = {
  INVALID: `Enter a whole number between 1 and ${MAX_ADMISSION_CAPACITY}, or leave it empty to turn the waiting room off.`,
  NOT_ALLOWED: 'Not allowed for this event. Your account may not change its waiting room.',
  TOO_MANY: 'Too many requests. Wait a moment and try again.',
  REJECTED: 'The server rejected that capacity.',
  GENERIC: 'The waiting room could not be updated. Try again.',
} as const;

function mapCapacityError(error: Error): string {
  switch (error instanceof HttpErrorResponse ? error.status : 0) {
    case HttpStatusCode.NotFound:
    case HttpStatusCode.Forbidden:
      return PROBLEM.NOT_ALLOWED;
    case HttpStatusCode.TooManyRequests:
      return PROBLEM.TOO_MANY;
    case HttpStatusCode.BadRequest:
      return PROBLEM.REJECTED;
    default:
      return PROBLEM.GENERIC;
  }
}

/** Organizer/admin control to enable, resize or disable an event's waiting room. */
@Component({
  selector: 'app-waiting-room-settings',
  templateUrl: './waiting-room-settings.html',
  host: { class: 'card flex flex-col gap-3 p-4' },
})
export class WaitingRoomSettings {
  private readonly events = inject(EventsService);

  readonly eventId = input.required<string>();
  readonly capacity = input.required<number | null>();
  readonly saved = output<number | null>();

  protected readonly draft = linkedSignal(() =>
    this.capacity() === null ? '' : String(this.capacity())
  );
  protected readonly pending = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly confirmation = signal<string | null>(null);

  protected readonly parsed = computed<{ valid: true; value: number | null } | { valid: false }>(
    () => {
      const text = this.draft().trim();
      if (text === '') return { valid: true, value: null };
      const result = WaitingRoomCapacitySchema.safeParse(Number(text));
      return result.success ? { valid: true, value: result.data } : { valid: false };
    }
  );

  protected readonly unchanged = computed(() => {
    const candidate = this.parsed();
    return candidate.valid && candidate.value === this.capacity();
  });

  protected edit(value: string): void {
    this.draft.set(value);
    this.problem.set(null);
    this.confirmation.set(null);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const candidate = this.parsed();
    if (!candidate.valid) {
      this.confirmation.set(null);
      this.problem.set(PROBLEM.INVALID);
      return;
    }
    this.persist(candidate.value);
  }

  protected turnOff(): void {
    this.draft.set('');
    this.persist(null);
  }

  private persist(capacity: number | null): void {
    if (this.pending()) return;
    this.pending.set(true);
    this.problem.set(null);
    this.confirmation.set(null);
    this.events.setWaitingRoomCapacity(this.eventId(), capacity).subscribe({
      next: (summary) => {
        this.pending.set(false);
        this.draft.set(
          summary.waitingRoomCapacity === null ? '' : String(summary.waitingRoomCapacity)
        );
        this.confirmation.set(
          summary.waitingRoomCapacity === null
            ? 'Waiting room is now off.'
            : `Waiting room capacity is now ${summary.waitingRoomCapacity}.`
        );
        this.saved.emit(summary.waitingRoomCapacity);
      },
      error: (error: Error) => {
        this.pending.set(false);
        this.problem.set(mapCapacityError(error));
      },
    });
  }
}
