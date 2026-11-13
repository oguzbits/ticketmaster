import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ROLE, type Role } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tokensFor } from '../testing/tokens';
import { App } from './app';
import { routes } from './app.routes';
import { SessionStore } from './auth/session.store';

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
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
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
    TestBed.inject(HttpTestingController).expectOne('/api/events').flush([]);
    await fixture.whenStable();

    expect(element.textContent).toContain('No events yet');
  });

  it.each<[Role | null, string[]]>([
    [null, ['Events']],
    [ROLE.CUSTOMER, ['Events', 'My bookings']],
    [ROLE.ORGANIZER, ['Events', 'Organizer']],
    [ROLE.ADMIN, ['Events', 'Simulator']],
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
