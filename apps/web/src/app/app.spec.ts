import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { ROLE, type Role } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tokensFor } from '../testing/tokens';
import { App } from './app';
import { routes } from './app.routes';
import { SessionStore } from './auth/session.store';
import { EventSearchStore } from './events/event-search.store';

const EVENT_ID = '00000000-0000-4000-8000-0000000000a2';

function render() {
  const fixture = TestBed.createComponent(App);
  const element: HTMLElement = fixture.nativeElement;
  const logoutButton = () =>
    [...element.querySelectorAll('button')].find((button) => /log out/i.test(button.textContent));
  return { fixture, element, logoutButton };
}

describe('App', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes, withComponentInputBinding()),
      ],
    })
  );
  // Every request a test did not answer fails the test.
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the start page at the root and the unofficial notice', async () => {
    const { fixture, element, logoutButton } = render();
    await TestBed.inject(Router).navigateByUrl('/');
    await fixture.whenStable();

    expect(element.textContent).toContain('Try it as');
    expect(element.textContent).toContain('Unofficial demo. Not affiliated with Ticketmaster.');
    expect(logoutButton()).toBeUndefined();
  });

  it('shows the event list at /events', async () => {
    const { fixture, element } = render();
    await TestBed.inject(Router).navigateByUrl('/events');
    TestBed.tick();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/events')
      .flush({ items: [], nextCursor: null });
    await fixture.whenStable();

    expect(element.textContent).toContain('No events yet');
  });

  it('has a wordmark link to the start page outside the main navigation', () => {
    const { fixture, element } = render();
    fixture.detectChanges();

    const wordmark = element.querySelector('a[href="/"]');
    expect(wordmark?.textContent?.trim()).toBe('ticketmaster-klon');
    expect(wordmark?.closest('nav')).toBeNull();
    expect(wordmark?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the search field at /events only and writes the query to the store', async () => {
    const { fixture, element } = render();
    const router = TestBed.inject(Router);
    const http = TestBed.inject(HttpTestingController);
    const searchField = () =>
      element.querySelector<HTMLInputElement>('header form[role=search] input');

    await router.navigateByUrl('/');
    await fixture.whenStable();
    expect(searchField()).toBeNull();

    await router.navigateByUrl('/events');
    TestBed.tick();
    http.expectOne('/api/events').flush({ items: [], nextCursor: null });
    await fixture.whenStable();
    const field = searchField();
    expect(field?.type).toBe('search');
    expect(field?.closest('nav')).toBeNull();
    expect(element.querySelector('header form[role=search] label')?.textContent).toContain(
      'Search events'
    );
    if (field) {
      field.value = 'jazz';
      field.dispatchEvent(new Event('input'));
    }
    expect(TestBed.inject(EventSearchStore).query()).toBe('jazz');

    await router.navigateByUrl(`/events/${EVENT_ID}`);
    TestBed.tick();
    http.expectOne(`/api/events/${EVENT_ID}`);
    expect(searchField()).toBeNull();
  });

  it('marks the link of the current route', async () => {
    const { fixture, element } = render();
    await TestBed.inject(Router).navigateByUrl('/events');
    TestBed.tick();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/events')
      .flush({ items: [], nextCursor: null });
    await fixture.whenStable();

    const current = [...element.querySelectorAll('nav a[aria-current="page"]')];
    expect(current.map((a) => a.textContent?.trim())).toEqual(['Events']);
  });

  it.each<[Role | null, string[]]>([
    [null, ['Events']],
    [ROLE.CUSTOMER, ['Events', 'My bookings']],
    [ROLE.ORGANIZER, ['Events', 'Organizer']],
    [ROLE.ADMIN, ['Events', 'Simulator', 'Audit log']],
  ])('shows these header links for %s: %j', (role, links) => {
    if (role) TestBed.inject(SessionStore).set(tokensFor(role));
    const { fixture, element } = render();
    fixture.detectChanges();

    const names = [...element.querySelectorAll('nav a')].map((a) => a.textContent?.trim());
    expect(names).toEqual(links);
  });

  it('shows the role of the signed-in user and logs out to the start page', async () => {
    TestBed.inject(SessionStore).set(tokensFor(ROLE.ORGANIZER));
    const { fixture, element, logoutButton } = render();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await fixture.whenStable();
    expect(element.textContent).toContain('organizer');

    logoutButton()?.click();
    await fixture.whenStable();

    expect(TestBed.inject(SessionStore).isLoggedIn()).toBe(false);
    expect(logoutButton()).toBeUndefined();
    expect(router.url).toBe('/');
  });
});
