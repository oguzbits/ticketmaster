import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { BOOKING_STATUS, ROLE, type Seat, SEAT_STATUS } from '@app/shared';

import { SessionStore } from '../auth/session.store';
import { BOOKING_ACTION, BookingsStore } from '../bookings/bookings.store';
import { EventsService } from './events.service';

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

  constructor() {
    this.bookings.settled.pipe(takeUntilDestroyed()).subscribe(() => this.refreshSeats());
  }

  protected canChoose(seat: Seat): boolean {
    return this.isCustomer() && seat.status === this.available && this.bookings.canHold();
  }

  protected choose(seat: Seat): void {
    if (this.canChoose(seat)) this.bookings.hold(this.id(), seat.id);
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
