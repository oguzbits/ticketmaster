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

  /** The booking whose ticket is on its way: its button is disabled, a second click is ignored. */
  protected readonly downloading = signal<string | null>(null);
  /** The booking whose last download failed; the button then reads "Try again". */
  protected readonly downloadFailed = signal<string | null>(null);

  /** Only a confirmed booking has a ticket. */
  protected hasTicket(booking: Booking): boolean {
    return booking.status === BOOKING_STATUS.CONFIRMED;
  }

  protected downloadLabel(booking: Booking): string {
    if (this.downloading() === booking.id) return 'Downloading…';
    return this.downloadFailed() === booking.id ? 'Try again' : 'Download ticket';
  }

  protected download(booking: Booking): void {
    if (this.downloading() !== null) return;
    this.downloading.set(booking.id);
    this.downloadFailed.set(null);
    this.service.downloadTicket(booking.id).subscribe({
      next: (blob) => {
        saveFile(blob, `ticket-${booking.id}.pdf`);
        this.downloading.set(null);
      },
      error: () => {
        this.downloadFailed.set(booking.id);
        this.downloading.set(null);
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

/** Hands the file to the browser through a temporary link; the object URL is released at once. */
function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
