import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { Component, computed, inject, input } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { type Seat, SEAT_STATUS } from '@app/shared';

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
})
export class SeatMap {
  /** The route parameter, bound by the router. */
  readonly id = input.required<string>();

  private readonly eventsService = inject(EventsService);

  protected readonly event = rxResource({
    params: () => this.id(),
    stream: ({ params }) => this.eventsService.detail(params),
  });

  protected readonly notFound = computed(() => {
    const error = this.event.error();
    return error instanceof HttpErrorResponse && error.status === HttpStatusCode.NotFound;
  });

  protected readonly legend = Object.values(SEAT_STATUS);
  protected readonly available = SEAT_STATUS.AVAILABLE;

  /** The API sends the seats ordered by section, row and number. */
  protected readonly sections = computed<SeatSection[]>(() => {
    const sections: SeatSection[] = [];
    for (const seat of this.event.value()?.seats ?? []) {
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

  protected label(seat: Seat): string {
    return `Section ${seat.section}, row ${seat.row}, seat ${seat.number}, ${seat.status.toLowerCase()}`;
  }
}
