import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BOOKING_STRATEGY, type EventSummary } from '@app/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { EventList } from './event-list';
import { EventSearchStore } from './event-search.store';
import { strategyLabel } from './strategy-label';

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
  const search = TestBed.inject(EventSearchStore);
  const cards = () => [...element.querySelectorAll('a')];
  return { fixture, element, http, answer, search, cards };
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

  it('renders one card per event whose text starts with the event name', async () => {
    const { http, answer, cards } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush(EVENTS));

    expect(cards().map((card) => card.textContent?.trim())).toEqual([
      expect.stringMatching(/^Symphony Evening/),
      expect.stringMatching(/^Jazz Gala/),
    ]);
    expect(cards().map((card) => card.getAttribute('href'))).toEqual(
      EVENTS.map((event) => `/events/${event.id}`)
    );
  });

  it('shows the strategy label and not the raw value', async () => {
    const { http, answer, cards } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush(EVENTS));

    expect(cards()[0]?.textContent).toContain(strategyLabel(BOOKING_STRATEGY.PESSIMISTIC));
    expect(cards()[0]?.textContent).not.toContain(BOOKING_STRATEGY.PESSIMISTIC);
  });

  it('puts the start time of the event into the datetime attribute', async () => {
    const { element, http, answer } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush(EVENTS));

    expect(
      [...element.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))
    ).toEqual(EVENTS.map((event) => event.startsAt));
  });

  it('filters the cards by the query without another request', async () => {
    const { fixture, http, answer, search, cards } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush(EVENTS));

    search.query.set('jazz');
    await fixture.whenStable();

    expect(cards().map((card) => card.textContent)).toEqual([expect.stringContaining('Jazz Gala')]);
  });

  it('says that no event matches and restores the list with Clear search', async () => {
    const { fixture, element, http, answer, search, cards } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush(EVENTS));

    search.query.set('opera');
    await fixture.whenStable();
    expect(element.textContent).toContain('No events match “opera”.');
    expect(cards()).toHaveLength(0);

    [...element.querySelectorAll('button')]
      .find((button) => /clear search/i.test(button.textContent))
      ?.click();
    await fixture.whenStable();

    expect(search.query()).toBe('');
    expect(cards()).toHaveLength(EVENTS.length);
  });

  it('keeps the loading state when a query is active', () => {
    const { element, http, search } = render();
    search.query.set('opera');
    TestBed.tick();

    expect(element.querySelector('[role=status]')).not.toBeNull();
    expect(element.textContent).not.toContain('No events match');
    http.expectOne(EVENTS_URL);
  });

  it('keeps the error state with its retry when a query is active', async () => {
    const { element, http, answer, search } = render();
    search.query.set('opera');
    await answer(() =>
      http.expectOne(EVENTS_URL).flush(null, { status: 503, statusText: 'Service Unavailable' })
    );

    expect(element.querySelector('[role=alert]')).not.toBeNull();
    expect(element.textContent).toContain('Try again');
    expect(element.textContent).not.toContain('No events match');
  });

  it('clears the query when the list is destroyed', async () => {
    const { fixture, http, answer, search } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush(EVENTS));
    search.query.set('jazz');

    fixture.destroy();

    expect(search.query()).toBe('');
  });
});
