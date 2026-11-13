import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { BOOKING_STATUS, ROLE, type Seat, SEAT_STATUS, SEAT_STREAM_EVENT } from '@app/shared';
import { EMPTY, switchMap } from 'rxjs';

import { SessionStore } from '../auth/session.store';
import { BOOKING_ACTION, BookingsStore } from '../bookings/bookings.store';
import { EventsService } from './events.service';
import {
  SEAT_STREAM_STATE,
  type SeatStreamMessage,
  SeatStreamService,
} from './seat-stream.service';

interface SeatRow {
  row: number;
  seats: Seat[];
}
interface SeatSection {
  name: string;
  priceCents: number;
  rows: SeatRow[];
}

@Component({
  selector: 'app-seat-map',
  imports: [CurrencyPipe, DatePipe, RouterLink],
  templateUrl: './seat-map.html',
  providers: [BookingsStore],
})
export class SeatMap {
  /** The route parameter, bound by the router. */
  readonly id = input.required<string>();

  private readonly eventsService = inject(EventsService);
  private readonly stream = inject(SeatStreamService);
  private readonly session = inject(SessionStore);
  protected readonly bookings = inject(BookingsStore);

  protected readonly event = rxResource({
    params: () => this.id(),
    stream: ({ params }) => this.eventsService.detail(params),
  });

  /** The seats as the server last told us; a booking action reads them again. */
  protected readonly seats = linkedSignal(() => this.event.value()?.seats ?? []);

  protected readonly role = this.session.role;
  protected readonly isCustomer = computed(() => this.role() === ROLE.CUSTOMER);
  protected readonly action = BOOKING_ACTION;
  protected readonly held = BOOKING_STATUS.HELD;
  protected readonly confirmed = BOOKING_STATUS.CONFIRMED;
  protected readonly cancelled = BOOKING_STATUS.CANCELLED;

  protected readonly notFound = computed(() => {
    const error = this.event.error();
    return error instanceof HttpErrorResponse && error.status === HttpStatusCode.NotFound;
  });

  protected readonly legend = Object.values(SEAT_STATUS);
  protected readonly available = SEAT_STATUS.AVAILABLE;

  /** The API sends the seats ordered by section, row and number. */
  protected readonly sections = computed<SeatSection[]>(() => {
    const sections: SeatSection[] = [];
    for (const seat of this.seats()) {
      let section = sections.at(-1);
      if (section?.name !== seat.section) {
        section = { name: seat.section, priceCents: seat.priceCents, rows: [] };
        sections.push(section);
      }
      let row = section.rows.at(-1);
      if (row?.row !== seat.row) {
        row = { row: seat.row, seats: [] };
        section.rows.push(row);
      }
      row.seats.push(seat);
    }
    return sections;
  });

  /** Where the live connection stands, for the notice above the map. */
  protected readonly live = signal<'connecting' | 'live' | 'reconnecting' | 'busy' | 'stopped'>(
    'connecting'
  );
  /** The last change in words, for a polite live region (the focus stays where it is). */
  protected readonly announcement = signal('');

  constructor() {
    // The stream starts once the detail is loaded, so its snapshot is newer than the detail.
    toObservable(computed(() => (this.event.hasValue() ? this.id() : null)))
      .pipe(
        switchMap((id) => (id === null ? EMPTY : this.stream.changes(id))),
        takeUntilDestroyed()
      )
      .subscribe({
        next: (message) => this.apply(message),
        error: () => this.live.set('stopped'),
      });
    this.bookings.settled.pipe(takeUntilDestroyed()).subscribe(() => this.refreshSeats());
  }

  protected canChoose(seat: Seat): boolean {
    return this.isCustomer() && seat.status === this.available && this.bookings.canHold();
  }

  protected choose(seat: Seat): void {
    if (this.canChoose(seat)) this.bookings.hold(this.id(), seat.id);
  }

  private apply(message: SeatStreamMessage): void {
    switch (message.type) {
      case SEAT_STREAM_EVENT.SNAPSHOT:
        this.live.set('live');
        this.seats.set(message.snapshot.seats);
        break;
      case SEAT_STREAM_EVENT.CHANGE: {
        const { seatId, status } = message.change;
        const seat = this.seats().find((candidate) => candidate.id === seatId);
        if (!seat) break;
        this.seats.update((seats) =>
          seats.map((candidate) => (candidate === seat ? { ...candidate, status } : candidate))
        );
        this.announcement.set(
          `Section ${seat.section}, row ${seat.row}, seat ${seat.number} is now ${status.toLowerCase()}`
        );
        break;
      }
      case SEAT_STREAM_STATE.RECONNECTING:
        this.live.set(message.busy ? 'busy' : 'reconnecting');
        break;
    }
  }

  protected readonly refreshFailed = signal(false);

  protected refreshSeats(): void {
    this.eventsService.detail(this.id()).subscribe({
      next: (detail) => {
        this.refreshFailed.set(false);
        this.seats.set(detail.seats);
      },
      error: () => this.refreshFailed.set(true),
    });
  }

  protected label(seat: Seat): string {
    return `Section ${seat.section}, row ${seat.row}, seat ${seat.number}, ${seat.status.toLowerCase()}`;
  }
}
