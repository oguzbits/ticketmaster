import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { BOOKING_STRATEGY, type OrganizerEvent, ROLE, type Role } from '@app/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { tokensFor } from '../../testing/tokens';
import { routes } from '../app.routes';
import { SessionStore } from '../auth/session.store';
import { OrganizerEvents } from './organizer-events';

const LIST_URL = '/api/organizer/events';
const VENUES_URL = '/api/venues';
const GALA: OrganizerEvent = {
  id: '00000000-0000-4000-8000-0000000000e1',
  name: 'Gala',
  startsAt: '2099-01-01T19:00:00.000Z',
  venueName: 'Hall',
  strategy: BOOKING_STRATEGY.PESSIMISTIC,
  waitingRoomCapacity: null,
  seatCount: 40,
  soldCount: 10,
  heldCount: 2,
  utilization: 0.25,
};

function render() {
  TestBed.configureTestingModule({
    imports: [OrganizerEvents],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(OrganizerEvents);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const answer = async (respond: () => void) => {
    respond();
    await fixture.whenStable();
  };
  TestBed.tick();
  return { element, http, answer };
}

describe('OrganizerEvents', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows loading, then each own event with its sales and utilization', async () => {
    const { element, http, answer } = render();
    http.expectOne(VENUES_URL).flush([]);
    expect(element.querySelector('[role=status]')?.textContent).toContain('Loading your events');

    await answer(() => http.expectOne(LIST_URL).flush([GALA]));

    const text = element.textContent ?? '';
    expect(text).toContain('Gala');
    expect(text).toContain('10 of 40 seats sold');
    expect(text).toContain('2 held');
    expect(text).toContain('25% utilization');
    expect(element.querySelector(`a[href="/events/${GALA.id}"]`)).not.toBeNull();
  });

  it('says so when the organizer has no events yet', async () => {
    const { element, http, answer } = render();
    http.expectOne(VENUES_URL).flush([]);

    await answer(() => http.expectOne(LIST_URL).flush([]));

    expect(element.textContent).toContain('No events yet');
  });

  it('offers a retry when the list fails and loads again on click', async () => {
    const { element, http, answer } = render();
    http.expectOne(VENUES_URL).flush([]);
    await answer(() =>
      http.expectOne(LIST_URL).flush(null, { status: 503, statusText: 'Service Unavailable' })
    );
    expect(element.textContent).toContain('could not be loaded');

    const retry = [...element.querySelectorAll('button')].find((b) =>
      /Try again/.test(b.textContent)
    );
    retry?.click();
    TestBed.tick();
    await answer(() => http.expectOne(LIST_URL).flush([GALA]));

    expect(element.textContent).toContain('Gala');
  });

  it('reads the list again after an event was created', async () => {
    const { element, http, answer } = render();
    http.expectOne(VENUES_URL).flush([{ id: GALA.id, name: 'Hall', seatCount: 40 }]);
    await answer(() => http.expectOne(LIST_URL).flush([]));

    const name = element.querySelector<HTMLInputElement>('#event-name');
    const starts = element.querySelector<HTMLInputElement>('#event-starts-at');
    if (!name || !starts) throw new Error('form missing');
    name.value = 'Gala';
    name.dispatchEvent(new Event('input'));
    starts.value = '2099-01-01T19:00';
    starts.dispatchEvent(new Event('input'));
    element
      .querySelector('button[type=submit]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    TestBed.tick();
    http.expectOne('/api/events').flush({
      id: GALA.id,
      name: 'Gala',
      startsAt: GALA.startsAt,
      venueName: 'Hall',
      strategy: GALA.strategy,
      waitingRoomCapacity: GALA.waitingRoomCapacity,
    });
    TestBed.tick();

    await answer(() => http.expectOne(LIST_URL).flush([GALA]));
    expect(element.textContent).toContain('10 of 40 seats sold');
  });
});

describe('organizer route', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  async function visit(role: Role | null) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
    });
    if (role) TestBed.inject(SessionStore).set(tokensFor(role));
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/organizer');
    return router.url;
  }

  it('lets an organizer open the screen', async () => {
    expect(await visit(ROLE.ORGANIZER)).toBe('/organizer');
  });

  it.each([ROLE.CUSTOMER, ROLE.ADMIN])('sends %s to the event list', async (role) => {
    expect(await visit(role)).toBe('/events');
  });

  it('sends a visitor without a session to the start page', async () => {
    expect(await visit(null)).toBe('/');
  });
});
