import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BOOKING_STRATEGY, type EventSummary } from '@app/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  const answer = async (respond: () => void) => {
    respond();
    await fixture.whenStable();
  };
  TestBed.tick();
  const search = TestBed.inject(EventSearchStore);
  const cards = () => [...element.querySelectorAll('a')];
  const button = (name: RegExp) =>
    [...element.querySelectorAll('button')].find((candidate) => name.test(candidate.textContent));
  return { fixture, element, http, answer, search, cards, button };
}

describe('EventList', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.inject(HttpTestingController).verify();
  });

  it('shows a loading state, then the event names as links', async () => {
    const { element, http, answer } = render();
    expect(element.querySelector('[role=status]')).not.toBeNull();

    await answer(() => http.expectOne(EVENTS_URL).flush({ items: EVENTS, nextCursor: null }));

    const links = [...element.querySelectorAll('a')].map((link) => link.textContent);
    expect(links.join(' ')).toContain('Symphony Evening');
    expect(links.join(' ')).toContain('Jazz Gala');
    expect(element.querySelector('[role=status]')).toBeNull();
  });

  it('shows the empty message when there are no events', async () => {
    const { element, http, answer } = render();

    await answer(() => http.expectOne(EVENTS_URL).flush({ items: [], nextCursor: null }));

    expect(element.textContent).toContain('No events yet');
  });

  it('offers a retry when the API fails and loads again on click', async () => {
    const { element, http, answer, button } = render();
    await answer(() =>
      http.expectOne(EVENTS_URL).flush(null, { status: 503, statusText: 'Service Unavailable' })
    );
    expect(element.querySelector('[role=alert]')).not.toBeNull();

    button(/try again/i)?.click();
    TestBed.tick();
    await answer(() => http.expectOne(EVENTS_URL).flush({ items: EVENTS, nextCursor: null }));

    expect(element.textContent).toContain('Symphony Evening');
    expect(element.querySelector('[role=alert]')).toBeNull();
  });

  it('renders one card per event whose text starts with the event name and shows strategy label', async () => {
    const { http, answer, cards } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush({ items: EVENTS, nextCursor: null }));

    expect(cards().map((card) => card.textContent?.trim())).toEqual([
      expect.stringMatching(/^Symphony Evening/),
      expect.stringMatching(/^Jazz Gala/),
    ]);
    expect(cards().map((card) => card.getAttribute('href'))).toEqual(
      EVENTS.map((event) => `/events/${event.id}`)
    );
    expect(cards()[0]?.textContent).toContain(strategyLabel(BOOKING_STRATEGY.PESSIMISTIC));
    expect(cards()[0]?.textContent).not.toContain(BOOKING_STRATEGY.PESSIMISTIC);
  });

  it('puts the start time of the event into the datetime attribute', async () => {
    const { element, http, answer } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush({ items: EVENTS, nextCursor: null }));

    expect(
      [...element.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))
    ).toEqual(EVENTS.map((event) => event.startsAt));
  });

  it('pages forward with keyset cursor and retries the failed cursor page', async () => {
    const first = EVENTS[0];
    const second = EVENTS[1];
    if (!first || !second) throw new Error('Expected test fixtures');
    const cursor = `${first.startsAt}|${first.id}`;
    const { element, http, answer, cards, button } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush({ items: [first], nextCursor: cursor }));

    button(/load more/i)?.click();
    TestBed.tick();
    await answer(() =>
      http
        .expectOne((req) => req.url === EVENTS_URL && req.params.get('cursor') === cursor)
        .flush(null, { status: 503, statusText: 'Service Unavailable' })
    );
    expect(element.querySelector('[role=alert]')).not.toBeNull();

    button(/try again/i)?.click();
    TestBed.tick();
    await answer(() =>
      http
        .expectOne((req) => req.url === EVENTS_URL && req.params.get('cursor') === cursor)
        .flush({ items: [second], nextCursor: null })
    );

    expect(cards()).toHaveLength(2);
    expect(button(/load more/i)).toBeUndefined();
  });

  it('sends server-side search query after debounce and clears filters cleanly', () => {
    vi.useFakeTimers();
    const { element, http, search, cards, button } = render();
    http.expectOne(EVENTS_URL).flush({ items: EVENTS, nextCursor: null });
    TestBed.tick();

    search.query.set('opera');
    TestBed.tick();
    vi.advanceTimersByTime(250);
    http
      .expectOne((req) => req.url === EVENTS_URL && req.params.get('q') === 'opera')
      .flush({ items: [], nextCursor: null });
    TestBed.tick();

    expect(element.querySelector('[role=status]')?.textContent).toContain(
      'No events match “opera”.'
    );
    expect(cards()).toHaveLength(0);

    button(/clear filters/i)?.click();
    TestBed.tick();
    http.expectOne(EVENTS_URL).flush({ items: EVENTS, nextCursor: null });
    TestBed.tick();
    vi.advanceTimersByTime(250);

    expect(search.query()).toBe('');
    expect(cards()).toHaveLength(EVENTS.length);
  });

  it('sends from, to, and maxPriceCents filters to the API and rejects invalid price input', async () => {
    const { element, http, answer } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush({ items: EVENTS, nextCursor: null }));

    const fromInput = element.querySelector<HTMLInputElement>('#event-filter-from');
    const toInput = element.querySelector<HTMLInputElement>('#event-filter-to');
    const priceInput = element.querySelector<HTMLInputElement>('#event-filter-price');
    if (!fromInput || !toInput || !priceInput) throw new Error('Filter inputs missing');

    fromInput.value = '2027-06-01';
    fromInput.dispatchEvent(new Event('change'));
    TestBed.tick();
    await answer(() =>
      http
        .expectOne(
          (req) => req.url === EVENTS_URL && req.params.get('from') === '2027-06-01T00:00:00.000Z'
        )
        .flush({ items: EVENTS, nextCursor: null })
    );

    toInput.value = '2027-06-30';
    toInput.dispatchEvent(new Event('change'));
    TestBed.tick();
    await answer(() =>
      http
        .expectOne(
          (req) => req.url === EVENTS_URL && req.params.get('to') === '2027-06-30T23:59:59.999Z'
        )
        .flush({ items: EVENTS, nextCursor: null })
    );

    priceInput.value = '-5';
    priceInput.dispatchEvent(new Event('change'));
    TestBed.tick();
    http.expectNone(EVENTS_URL);
    expect(element.querySelector('[role=alert]')?.textContent).toContain('positive whole euro');

    priceInput.value = '60';
    priceInput.dispatchEvent(new Event('change'));
    TestBed.tick();
    await answer(() =>
      http
        .expectOne((req) => req.url === EVENTS_URL && req.params.get('maxPriceCents') === '6000')
        .flush({ items: EVENTS.slice(0, 1), nextCursor: null })
    );
  });

  it('keeps the loading and error states when an initial query is active', async () => {
    TestBed.configureTestingModule({
      imports: [EventList],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    const search = TestBed.inject(EventSearchStore);
    search.query.set('opera');
    const fixture = TestBed.createComponent(EventList);
    const element: HTMLElement = fixture.nativeElement;
    const http = TestBed.inject(HttpTestingController);
    TestBed.tick();

    expect(element.querySelector('[role=status]')).not.toBeNull();
    expect(element.textContent).not.toContain('No events match');

    http
      .expectOne((req) => req.url === EVENTS_URL && req.params.get('q') === 'opera')
      .flush(null, { status: 503, statusText: 'Service Unavailable' });
    await fixture.whenStable();

    expect(element.querySelector('[role=alert]')).not.toBeNull();
    expect(element.textContent).toContain('Try again');
    expect(element.textContent).not.toContain('No events match');
  });

  it('clears the query when the list is destroyed', async () => {
    const { fixture, http, answer, search } = render();
    await answer(() => http.expectOne(EVENTS_URL).flush({ items: EVENTS, nextCursor: null }));
    search.query.set('jazz');

    fixture.destroy();

    expect(search.query()).toBe('');
  });
});
