import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BOOKING_STRATEGY, type EventDetail, SEAT_STATUS } from '@app/shared';
import { afterEach, describe, expect, it } from 'vitest';

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

function render() {
  TestBed.configureTestingModule({
    imports: [SeatMap],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(SeatMap);
  fixture.componentRef.setInput('id', EVENT_ID);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const answer = async (respond: () => void) => {
    respond();
    await fixture.whenStable();
  };
  TestBed.tick();
  return { element, http, answer };
}

describe('SeatMap', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders every seat in the tab order with its status in the accessible name', async () => {
    const { element, http, answer } = render();
    expect(element.querySelector('[role=status]')).not.toBeNull();

    await answer(() => http.expectOne(EVENT_URL).flush(DETAIL));

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
});
