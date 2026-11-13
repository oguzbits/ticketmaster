import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  type Booking,
  BookingListResponseSchema,
  BookingSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
} from '@app/shared';
import { map, type Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class BookingsService {
  private readonly http = inject(HttpClient);

  /** The user comes from the token, so the body names only the event and the seat. */
  hold(eventId: string, seatId: string): Observable<Booking> {
    return this.http
      .post('/api/bookings', { eventId, seatId })
      .pipe(map((body) => BookingSchema.parse(body)));
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
}
