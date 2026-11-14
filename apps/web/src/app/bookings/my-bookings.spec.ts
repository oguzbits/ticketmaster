import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { type Booking, BOOKING_STATUS, ROLE, TRANSITION_REASON } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tokensFor } from '../../testing/tokens';
import { routes } from '../app.routes';
import { SessionStore } from '../auth/session.store';
import { MyBookings } from './my-bookings';

const LIST_URL = '/api/bookings';
const BOOKING: Booking = {
  id: '00000000-0000-4000-8000-0000000000b1',
  eventId: '00000000-0000-4000-8000-0000000000a2',
  seatId: '00000000-0000-4000-8000-000000000101',
  status: BOOKING_STATUS.CONFIRMED,
  holdExpiresAt: '2027-06-01T19:02:00.000Z',
  ticketReady: false,
  seat: { section: 'A', row: 3, number: 7 },
  transitions: [
    {
      fromStatus: BOOKING_STATUS.HELD,
      toStatus: BOOKING_STATUS.CONFIRMED,
      reason: TRANSITION_REASON.CONFIRMED,
      at: '2027-06-01T19:01:00.000Z',
    },
    {
      fromStatus: null,
      toStatus: BOOKING_STATUS.HELD,
      reason: TRANSITION_REASON.HOLD,
      at: '2027-06-01T19:00:00.000Z',
    },
  ],
};
const CANCELLED: Booking = {
  ...BOOKING,
  id: BOOKING.id.replace('b1', 'b2'),
  status: BOOKING_STATUS.CANCELLED,
};

function render() {
  TestBed.configureTestingModule({
    imports: [MyBookings],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(MyBookings);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const answer = async (respond: () => void) => {
    respond();
    await fixture.whenStable();
  };
  TestBed.tick();
  const button = (name: RegExp) =>
    [...element.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
  return { element, http, answer, button };
}

describe('MyBookings', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows loading, then each booking with its status in words and its transitions', async () => {
    const { element, http, answer } = render();
    expect(element.querySelector('[role=status]')?.textContent).toContain('Loading');

    await answer(() => http.expectOne(LIST_URL).flush([BOOKING, CANCELLED]));

    const text = element.textContent ?? '';
    expect(text).toContain('Section A, row 3, seat 7');
    expect(text).toContain('Status: confirmed');
    expect(text).toContain('Status: cancelled');
    expect(text).toContain('held to confirmed (confirmed)');
    expect(text).toContain('new to held (hold)');
    expect(element.querySelector('a[href="/events/' + BOOKING.eventId + '"]')).not.toBeNull();
    // Only a held or confirmed booking can be cancelled.
    expect(element.querySelectorAll('button')).toHaveLength(1);
  });

  it('says so when there are no bookings', async () => {
    const { element, http, answer } = render();

    await answer(() => http.expectOne(LIST_URL).flush([]));

    expect(element.textContent).toContain('No bookings yet');
    expect(element.querySelector('a[href="/events"]')).not.toBeNull();
  });

  it('offers a retry when the list fails and loads again on click', async () => {
    const { element, http, answer, button } = render();
    await answer(() =>
      http.expectOne(LIST_URL).flush(null, { status: 503, statusText: 'Service Unavailable' })
    );
    expect(element.querySelector('[role=alert]')).not.toBeNull();

    button(/Try again/)?.click();
    TestBed.tick();
    await answer(() => http.expectOne(LIST_URL).flush([BOOKING]));

    expect(element.querySelector('[role=alert]')).toBeNull();
    expect(element.textContent).toContain('Status: confirmed');
  });

  it('cancels once for a double click and reloads the list', async () => {
    const { element, http, answer, button } = render();
    await answer(() => http.expectOne(LIST_URL).flush([BOOKING]));
    const cancel = button(/Cancel booking/);

    cancel?.click();
    cancel?.click();
    http
      .expectOne(`${LIST_URL}/${BOOKING.id}/cancel`)
      .flush({ ...BOOKING, status: CANCELLED.status });
    TestBed.tick();
    await answer(() => http.expectOne(LIST_URL).flush([{ ...BOOKING, status: CANCELLED.status }]));

    expect(element.textContent).toContain('Status: cancelled');
    expect(button(/Cancel booking/)).toBeUndefined();
  });

  it('tells the user when a cancellation fails and keeps the booking', async () => {
    const { element, http, answer, button } = render();
    await answer(() => http.expectOne(LIST_URL).flush([BOOKING]));

    button(/Cancel booking/)?.click();
    http
      .expectOne(`${LIST_URL}/${BOOKING.id}/cancel`)
      .flush(null, { status: 500, statusText: 'Server Error' });
    TestBed.tick();
    await answer(() => http.expectOne(LIST_URL).flush([BOOKING]));

    expect(element.querySelector('[role=alert]')?.textContent).toContain('could not be cancelled');
    expect(button(/Cancel booking/)?.disabled).toBe(false);
  });
});

describe('MyBookings ticket', () => {
  const READY: Booking = { ...BOOKING, ticketReady: true };
  const TICKET_URL = `${LIST_URL}/${READY.id}/ticket`;
  const OBJECT_URL = 'blob:ticket';
  const createObjectURL = vi.fn(() => OBJECT_URL);
  const revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

  beforeEach(() => {
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.clearAllMocks();
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('says the ticket is being prepared and offers no download yet', async () => {
    const { element, http, answer, button } = render();

    await answer(() => http.expectOne(LIST_URL).flush([BOOKING]));

    expect(element.textContent).toContain('Ticket is being prepared');
    expect(button(/Download ticket/)).toBeUndefined();
  });

  it('offers no ticket for a booking that is not confirmed', async () => {
    const { element, http, answer, button } = render();

    await answer(() =>
      http.expectOne(LIST_URL).flush([{ ...CANCELLED, ticketReady: true }, { ...CANCELLED }])
    );

    expect(element.textContent).not.toContain('Ticket is being prepared');
    expect(button(/Download ticket/)).toBeUndefined();
  });

  it('downloads once for a double click and releases the object URL', async () => {
    const { element, http, answer, button } = render();
    await answer(() => http.expectOne(LIST_URL).flush([READY]));
    expect(element.textContent).not.toContain('Ticket is being prepared');
    const download = button(/Download ticket/);

    download?.click();
    download?.click();
    TestBed.tick();
    expect(download?.disabled).toBe(true);
    http.expectOne(TICKET_URL).flush(new Blob(['%PDF']));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    // Not in the same task as the click: Safari and Firefox cancel the download otherwise.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL));
    expect(button(/Download ticket/)?.disabled).toBe(false);
  });

  it('shows an error with a retry when the download fails', async () => {
    const { element, http, answer, button } = render();
    await answer(() => http.expectOne(LIST_URL).flush([READY]));

    button(/Download ticket/)?.click();
    await answer(() =>
      http.expectOne(TICKET_URL).flush(null, { status: 500, statusText: 'Server Error' })
    );

    expect(element.querySelector('[role=alert]')?.textContent).toContain('could not be downloaded');
    expect(click).not.toHaveBeenCalled();

    button(/Try again/)?.click();
    await answer(() => http.expectOne(TICKET_URL).flush(new Blob(['%PDF'])));

    expect(click).toHaveBeenCalledTimes(1);
    expect(element.querySelector('[role=alert]')).toBeNull();
  });
});

describe('customer routes', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  async function visit(role: (typeof ROLE)[keyof typeof ROLE] | null, url: string) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
    });
    if (role) TestBed.inject(SessionStore).set(tokensFor(role));
    const router = TestBed.inject(Router);
    await router.navigateByUrl(url);
    return router.url;
  }

  it('lets a customer open my bookings', async () => {
    expect(await visit(ROLE.CUSTOMER, '/bookings')).toBe('/bookings');
  });

  it.each([ROLE.ORGANIZER, ROLE.ADMIN])('sends %s to the event list', async (role) => {
    expect(await visit(role, '/bookings')).toBe('/events');
  });

  it('sends a visitor without a session to the start page', async () => {
    expect(await visit(null, '/bookings')).toBe('/');
  });
});
