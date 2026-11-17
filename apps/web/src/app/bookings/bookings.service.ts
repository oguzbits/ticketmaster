import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  type Booking,
  BookingListResponseSchema,
  BookingSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  type TicketDownload,
  TicketDownloadSchema,
} from '@app/shared';
import { map, type Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class BookingsService {
  private readonly http = inject(HttpClient);

  /** The user comes from the token, so the body names only the event, seats and optional admission token. */
  hold(eventId: string, seatIds: readonly string[], admissionToken?: string): Observable<Booking> {
    const body =
      admissionToken === undefined ? { eventId, seatIds } : { eventId, seatIds, admissionToken };
    return this.http.post('/api/bookings', body).pipe(map((body) => BookingSchema.parse(body)));
  }

  /** The same key again returns the first answer without a second charge. */
  pay(bookingId: string, idempotencyKey: string): Observable<Booking> {
    const headers = { [IDEMPOTENCY_KEY_HEADER]: IdempotencyKeySchema.parse(idempotencyKey) };
    return this.http
      .post(`/api/bookings/${encodeURIComponent(bookingId)}/payment`, {}, { headers })
      .pipe(map((body) => BookingSchema.parse(body)));
  }

  cancel(bookingId: string): Observable<Booking> {
    return this.http
      .post(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, {})
      .pipe(map((body) => BookingSchema.parse(body)));
  }

  list(): Observable<Booking[]> {
    return this.http
      .get('/api/bookings')
      .pipe(map((body) => BookingListResponseSchema.parse(body)));
  }

  /** A short-lived presigned download URL for the ticket PDF of a confirmed booking. */
  downloadTicket(bookingId: string): Observable<TicketDownload> {
    return this.http
      .get(`/api/bookings/${encodeURIComponent(bookingId)}/ticket`)
      .pipe(map((body) => TicketDownloadSchema.parse(body)));
  }
}
