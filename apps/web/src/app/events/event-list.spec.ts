import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BOOKING_STRATEGY, type EventSummary } from '@app/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { EventList } from './event-list';

const EVENTS_URL = '/api/events';
const EVENTS: EventSummary[] = [
  {
    id: '00000000-0000-4000-8000-0000000000a2',
    name: 'Symphony Evening',
    startsAt: '2027-06-01T19:00:00.000Z',
    venueName: 'Hall',
    strategy: BOOKING_STRATEGY.PESSIMISTIC,
    waitingRoomCapacity: null,
  },
  {
    id: '00000000-0000-4000-8000-0000000000a3',
    name: 'Jazz Gala',
    startsAt: '2027-06-02T19:00:00.000Z',
    venueName: 'Hall',
    strategy: BOOKING_STRATEGY.OPTIMISTIC,
    waitingRoomCapacity: null,
  },
];

function render() {
  TestBed.configureTestingModule({
    imports: [EventList],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(EventList);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  // The app is not stable while a request is open, so only wait after answering one.
  const answer = async (respond: () => void) => {
    respond();
    await fixture.whenStable();
  };
  TestBed.tick();
  return { element, http, answer };
}

describe('EventList', () => {
  // Every request a test did not answer fails the test.
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows a loading state, then the event names as links', async () => {
    const { element, http, answer } = render();
    expect(element.querySelector('[role=status]')).not.toBeNull();

    await answer(() => http.expectOne(EVENTS_URL).flush(EVENTS));

    const links = [...element.querySelectorAll('a')].map((link) => link.textContent);
    expect(links.join(' ')).toContain('Symphony Evening');
    expect(links.join(' ')).toContain('Jazz Gala');
    expect(element.querySelector('[role=status]')).toBeNull();
  });

  it('shows the empty message when there are no events', async () => {
    const { element, http, answer } = render();

    await answer(() => http.expectOne(EVENTS_URL).flush([]));

    expect(element.textContent).toContain('No events yet');
  });

  it('offers a retry when the API fails and loads again on click', async () => {
    const { element, http, answer } = render();
    await answer(() =>
      http.expectOne(EVENTS_URL).flush(null, { status: 503, statusText: 'Service Unavailable' })
    );
    expect(element.querySelector('[role=alert]')).not.toBeNull();

    element.querySelector('button')?.click();
    TestBed.tick();
    await answer(() => http.expectOne(EVENTS_URL).flush(EVENTS));

    expect(element.textContent).toContain('Symphony Evening');
    expect(element.querySelector('[role=alert]')).toBeNull();
  });
});
