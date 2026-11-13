import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { type Booking, BOOKING_STATUS, IDEMPOTENCY_KEY_HEADER } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BookingsService } from './bookings.service';

const BOOKING: Booking = {
  id: '00000000-0000-4000-8000-0000000000b1',
  eventId: '00000000-0000-4000-8000-0000000000a2',
  seatId: '00000000-0000-4000-8000-000000000101',
  status: BOOKING_STATUS.HELD,
  holdExpiresAt: '2027-06-01T19:02:00.000Z',
  seat: { section: 'A', row: 3, number: 7 },
  transitions: [],
};
const KEY = '00000000-0000-4000-8000-0000000000c1';

describe('BookingsService', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('hold posts the event and the seat only', () => {
    const http = TestBed.inject(HttpTestingController);
    let result: Booking | null = null;
    TestBed.inject(BookingsService)
      .hold(BOOKING.eventId, BOOKING.seatId)
      .subscribe((booking) => (result = booking));

    const request = http.expectOne('/api/bookings');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ eventId: BOOKING.eventId, seatId: BOOKING.seatId });
    request.flush(BOOKING);

    expect(result).toEqual(BOOKING);
  });

  it('pay sends the idempotency key as a header', () => {
    const http = TestBed.inject(HttpTestingController);
    TestBed.inject(BookingsService).pay(BOOKING.id, KEY).subscribe();

    const request = http.expectOne(`/api/bookings/${BOOKING.id}/payment`);
    expect(request.request.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(KEY);
    request.flush({ ...BOOKING, status: BOOKING_STATUS.CONFIRMED });
  });

  it('pay refuses a key that is not a UUID before any request', () => {
    expect(() => TestBed.inject(BookingsService).pay(BOOKING.id, 'order-1')).toThrow();
  });

  it('cancel posts to the cancel route and list reads the own bookings', () => {
    const http = TestBed.inject(HttpTestingController);
    const service = TestBed.inject(BookingsService);
    service.cancel(BOOKING.id).subscribe();
    http
      .expectOne(`/api/bookings/${BOOKING.id}/cancel`)
      .flush({ ...BOOKING, status: BOOKING_STATUS.CANCELLED });

    let listed: Booking[] = [];
    service.list().subscribe((bookings) => (listed = bookings));
    http.expectOne('/api/bookings').flush([BOOKING]);
    expect(listed).toEqual([BOOKING]);
  });

  it('rejects an answer that does not match the contract', () => {
    const http = TestBed.inject(HttpTestingController);
    let failed = false;
    TestBed.inject(BookingsService)
      .list()
      .subscribe({ error: () => (failed = true) });
    http.expectOne('/api/bookings').flush([{ id: 'x' }]);
    expect(failed).toBe(true);
  });
});
