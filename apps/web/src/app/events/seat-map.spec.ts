import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  type Booking,
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  type EventDetail,
  IDEMPOTENCY_KEY_HEADER,
  ROLE,
  type Role,
  SEAT_STATUS,
} from '@app/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { tokensFor } from '../../testing/tokens';
import { SessionStore } from '../auth/session.store';
import { SeatMap } from './seat-map';

const EVENT_ID = '00000000-0000-4000-8000-0000000000a2';
const EVENT_URL = `/api/events/${EVENT_ID}`;
const SEAT_ID = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;
const DETAIL: EventDetail = {
  id: EVENT_ID,
  name: 'Symphony Evening',
  startsAt: '2027-06-01T19:00:00.000Z',
  venueName: 'Hall',
  strategy: BOOKING_STRATEGY.PESSIMISTIC,
  seats: [
    { id: SEAT_ID(1), section: 'A', row: 3, number: 7, priceCents: 9000, status: SEAT_STATUS.HELD },
    { id: SEAT_ID(2), section: 'A', row: 3, number: 8, priceCents: 9000, status: SEAT_STATUS.SOLD },
    {
      id: SEAT_ID(3),
      section: 'B',
      row: 1,
      number: 1,
      priceCents: 7000,
      status: SEAT_STATUS.AVAILABLE,
    },
  ],
};

const BOOKING: Booking = {
  id: '00000000-0000-4000-8000-0000000000b1',
  eventId: EVENT_ID,
  seatId: SEAT_ID(3),
  status: BOOKING_STATUS.HELD,
  holdExpiresAt: '2027-01-01T00:02:00.000Z',
  seat: { section: 'B', row: 1, number: 1 },
  transitions: [],
};
const HOLD_SECONDS = 120;
const OPEN_SEAT = 'Section B, row 1, seat 1, available';

function render(role: Role | null = ROLE.CUSTOMER) {
  TestBed.configureTestingModule({
    imports: [SeatMap],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  if (role) TestBed.inject(SessionStore).set(tokensFor(role));
  const fixture = TestBed.createComponent(SeatMap);
  fixture.componentRef.setInput('id', EVENT_ID);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const answer = async (respond: () => void) => {
    respond();
    await fixture.whenStable();
  };
  TestBed.tick();
  const press = (name: string | RegExp) => {
    const button = [...element.querySelectorAll('button')].find((candidate) =>
      typeof name === 'string'
        ? candidate.getAttribute('aria-label') === name
        : name.test(candidate.textContent ?? '')
    );
    if (!button) throw new Error(`No button ${String(name)}`);
    button.click();
    TestBed.tick();
  };
  const loaded = () => answer(() => http.expectOne(EVENT_URL).flush(DETAIL));
  /** Every booking action re-reads the seats; the answer shows `status` for the open seat. */
  const refreshed = (status: DetailStatus) =>
    answer(() =>
      http.expectOne(EVENT_URL).flush({
        ...DETAIL,
        seats: DETAIL.seats.map((seat) => (seat.id === SEAT_ID(3) ? { ...seat, status } : seat)),
      })
    );
  return { element, http, answer, press, loaded, refreshed };
}
type DetailStatus = (typeof SEAT_STATUS)[keyof typeof SEAT_STATUS];

describe('SeatMap', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders every seat in the tab order with its status in the accessible name', async () => {
    const { element, loaded } = render();
    expect(element.querySelector('[role=status]')).not.toBeNull();

    await loaded();

    const buttons = [...element.querySelectorAll('button')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Section A, row 3, seat 7, held',
      'Section A, row 3, seat 8, sold',
      'Section B, row 1, seat 1, available',
    ]);
    // A native `disabled` would drop the seat from the tab order and hide it from screen readers.
    expect(buttons.every((button) => !button.disabled && button.tabIndex >= 0)).toBe(true);
    expect(buttons.map((button) => button.getAttribute('aria-disabled'))).toEqual([
      'true',
      'true',
      null,
    ]);
    expect(element.textContent).toContain('Symphony Evening');
  });

  it('shows not found when the event does not exist', async () => {
    const { element, http, answer } = render();

    await answer(() =>
      http.expectOne(EVENT_URL).flush(null, { status: 404, statusText: 'Not Found' })
    );

    expect(element.textContent).toContain('Event not found');
    expect(element.querySelector('button')).toBeNull();
  });

  it('offers a retry when the API fails and loads again on click', async () => {
    const { element, http, answer } = render();
    await answer(() =>
      http.expectOne(EVENT_URL).flush(null, { status: 503, statusText: 'Service Unavailable' })
    );
    expect(element.querySelector('[role=alert]')).not.toBeNull();

    element.querySelector('button')?.click();
    TestBed.tick();
    await answer(() => http.expectOne(EVENT_URL).flush(DETAIL));

    expect(element.querySelectorAll('button')).toHaveLength(3);
    expect(element.querySelector('[role=alert]')).toBeNull();
  });

  describe('booking', () => {
    const PAYMENT_URL = `/api/bookings/${BOOKING.id}/payment`;
    const FAILED = { status: 500, statusText: 'Server Error' };

    /** Opens the page as a customer and holds the open seat. */
    async function held() {
      const page = render();
      await page.loaded();
      page.press(OPEN_SEAT);
      const hold = page.http.expectOne('/api/bookings');
      expect(hold.request.body).toEqual({ eventId: EVENT_ID, seatId: SEAT_ID(3) });
      await page.answer(() => hold.flush(BOOKING));
      await page.refreshed(SEAT_STATUS.HELD);
      return page;
    }

    afterEach(() => vi.useRealTimers());

    it('holds a seat, counts down, pays and shows the confirmation', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(Date.parse('2027-01-01T00:00:00.000Z'));
      const { element, http, answer, press } = await held();
      expect(element.textContent).toContain('Hold expires in 2:00');
      expect(element.textContent).toContain('Section B, row 1, seat 1');

      vi.advanceTimersByTime(65_000);
      TestBed.tick();
      expect(element.textContent).toContain('Hold expires in 0:55');

      press(/Pay now/);
      const payment = http.expectOne(PAYMENT_URL);
      expect(payment.request.headers.get(IDEMPOTENCY_KEY_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
      await answer(() => payment.flush({ ...BOOKING, status: BOOKING_STATUS.CONFIRMED }));
      await answer(() => http.expectOne(EVENT_URL).flush(DETAIL));

      expect(element.textContent).toContain('Booking confirmed');
      expect(element.querySelector('a[href="/bookings"]')).not.toBeNull();
      expect(element.textContent).not.toContain('Hold expires');
    });

    it('cancels the hold', async () => {
      const { element, http, answer, press } = await held();

      press(/Cancel hold/);
      await answer(() =>
        http
          .expectOne(`/api/bookings/${BOOKING.id}/cancel`)
          .flush({ ...BOOKING, status: BOOKING_STATUS.CANCELLED })
      );
      await answer(() => http.expectOne(EVENT_URL).flush(DETAIL));

      expect(element.textContent).not.toContain('Hold expires');
      expect(element.textContent).toContain('Hold cancelled');
    });

    it('tells the user the seat was taken on a 409 and refreshes the seat', async () => {
      const { element, http, answer, press, loaded, refreshed } = render();
      await loaded();

      press(OPEN_SEAT);
      await answer(() =>
        http.expectOne('/api/bookings').flush(null, { status: 409, statusText: 'Conflict' })
      );
      await refreshed(SEAT_STATUS.SOLD);

      expect(element.querySelector('[role=alert]')?.textContent).toContain('just taken');
      expect(element.querySelector('[aria-label="Section B, row 1, seat 1, sold"]')).not.toBeNull();
      expect(element.textContent).not.toContain('Hold expires');
    });

    it('sends one hold request for a double click on a seat', async () => {
      const { element, http, loaded } = render();
      await loaded();
      const seat = element.querySelector<HTMLButtonElement>(`[aria-label="${OPEN_SEAT}"]`);

      seat?.click();
      seat?.click();
      TestBed.tick();

      expect(seat?.getAttribute('aria-disabled')).toBe('true');
      http.expectOne('/api/bookings').flush(null, FAILED);
      http.expectOne(EVENT_URL).flush(DETAIL);
    });

    it('sends one payment request for a double click', async () => {
      const { element, http } = await held();
      const pay = [...element.querySelectorAll('button')].find((b) =>
        /Pay now/.test(b.textContent ?? '')
      );

      // Both clicks arrive before Angular has rendered the disabled button.
      pay?.click();
      pay?.click();

      http.expectOne(PAYMENT_URL).flush(null, FAILED);
      http.expectOne(EVENT_URL).flush(DETAIL);
    });

    it('repeats the payment attempt with the same key after a server failure', async () => {
      const { element, http, answer, press } = await held();

      press(/Pay now/);
      const first = http.expectOne(PAYMENT_URL);
      const key = first.request.headers.get(IDEMPOTENCY_KEY_HEADER);
      await answer(() => first.flush(null, FAILED));
      await answer(() => http.expectOne(EVENT_URL).flush(DETAIL));
      expect(element.querySelector('[role=alert]')?.textContent).toContain('not confirmed');

      press(/Pay now/);
      const second = http.expectOne(PAYMENT_URL);
      expect(second.request.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(key);
      await answer(() => second.flush({ ...BOOKING, status: BOOKING_STATUS.CONFIRMED }));
      await answer(() => http.expectOne(EVENT_URL).flush(DETAIL));
    });

    it('offers a new hold after a failed payment and uses a new key for the next attempt', async () => {
      const { element, http, answer, press } = await held();
      press(/Pay now/);
      const first = http.expectOne(PAYMENT_URL);
      const key = first.request.headers.get(IDEMPOTENCY_KEY_HEADER);
      await answer(() => first.flush({ ...BOOKING, status: BOOKING_STATUS.CANCELLED }));
      await answer(() => http.expectOne(EVENT_URL).flush(DETAIL));
      expect(element.querySelector('[role=alert]')?.textContent).toContain('Payment failed');

      const again = [...element.querySelectorAll('button')].find((b) =>
        /Hold the seat again/.test(b.textContent ?? '')
      );
      again?.click();
      again?.click();
      const hold = http.expectOne('/api/bookings');
      expect(hold.request.body).toEqual({ eventId: EVENT_ID, seatId: SEAT_ID(3) });
      await answer(() => hold.flush(BOOKING));
      await answer(() => http.expectOne(EVENT_URL).flush(DETAIL));
      press(/Pay now/);

      const second = http.expectOne(PAYMENT_URL);
      expect(second.request.headers.get(IDEMPOTENCY_KEY_HEADER)).not.toBe(key);
      second.flush(null, FAILED);
      http.expectOne(EVENT_URL).flush(DETAIL);
    });

    it('stops offering payment once the hold has run out', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(Date.parse('2027-01-01T00:00:00.000Z'));
      const { element } = await held();

      vi.advanceTimersByTime((HOLD_SECONDS + 1) * 1000);
      TestBed.tick();

      expect(element.textContent).toContain('hold expired');
      expect(
        [...element.querySelectorAll('button')].some((b) => /Pay now/.test(b.textContent ?? ''))
      ).toBe(false);
    });

    it('shows the expired message when the server refuses the payment with 409', async () => {
      const { element, http, answer, press } = await held();

      press(/Pay now/);
      await answer(() =>
        http.expectOne(PAYMENT_URL).flush(null, { status: 409, statusText: 'Conflict' })
      );
      await answer(() => http.expectOne(EVENT_URL).flush(DETAIL));

      expect(element.querySelector('[role=alert]')?.textContent).toContain('hold expired');
    });

    it.each([ROLE.ORGANIZER, ROLE.ADMIN, null])(
      'is read-only for %s: a click on a free seat sends nothing',
      async (role) => {
        const { element, press, loaded } = render(role);
        await loaded();

        press(OPEN_SEAT);

        expect(
          element.querySelector('[aria-label="' + OPEN_SEAT + '"]')?.getAttribute('aria-disabled')
        ).toBe('true');
        expect(element.textContent).toMatch(role === null ? /Log in as a customer/ : /read-only/);
      }
    );
  });
});
