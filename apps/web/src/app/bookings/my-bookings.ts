import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { type Booking, BOOKING_STATUS, type BookingStatus } from '@app/shared';

import { BookingsService } from './bookings.service';

const CANCELLABLE: readonly BookingStatus[] = [BOOKING_STATUS.HELD, BOOKING_STATUS.CONFIRMED];

@Component({
  selector: 'app-my-bookings',
  imports: [DatePipe, RouterLink],
  templateUrl: './my-bookings.html',
})
export class MyBookings {
  private readonly service = inject(BookingsService);

  protected readonly bookings = rxResource({ stream: () => this.service.list() });

  /** The booking whose cancellation is on its way: its button is disabled, a second click is ignored. */
  protected readonly cancelling = signal<string | null>(null);
  protected readonly cancelFailed = signal(false);

  protected canCancel(booking: Booking): boolean {
    return CANCELLABLE.includes(booking.status);
  }

  protected cancel(booking: Booking): void {
    if (this.cancelling() !== null) return;
    this.cancelling.set(booking.id);
    this.cancelFailed.set(false);
    this.service.cancel(booking.id).subscribe({
      next: () => this.settle(),
      error: () => {
        this.cancelFailed.set(true);
        this.settle();
      },
    });
  }

  /** The status words of a stored transition, for example `held to confirmed`. */
  protected status(value: BookingStatus | null): string {
    return value === null ? 'new' : value.toLowerCase();
  }

  protected reason(value: string): string {
    return value.toLowerCase().replaceAll('_', ' ');
  }

  private settle(): void {
    this.cancelling.set(null);
    this.bookings.reload();
  }
}
