import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ROLE } from '@app/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { tokensFor } from '../../testing/tokens';
import { SessionStore } from '../auth/session.store';
import { EventSearchStore } from '../events/event-search.store';
import { StartPage } from './start-page';

const LOGIN_URL = '/api/demo-login';

function render() {
  TestBed.configureTestingModule({
    imports: [StartPage],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        { path: '', children: [] },
        { path: 'events', children: [] },
      ]),
    ],
  });
  const fixture = TestBed.createComponent(StartPage);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  // The app is not stable while a request is open, so only wait after answering one.
  const answer = async (respond: () => void) => {
    respond();
    await fixture.whenStable();
  };
  TestBed.tick();
  const button = (name: RegExp) =>
    [...element.querySelectorAll('button')].find((candidate) => name.test(candidate.textContent));
  return { element, http, answer, button };
}

describe('StartPage hero search', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  /** Types into the hero field and clicks the search button; returns the submit event. */
  async function searchFor(value: string, before?: () => void): Promise<Event> {
    const { element } = render();
    before?.();
    const field = element.querySelector<HTMLInputElement>('input[type=search]');
    const form = element.querySelector('form');
    const button = form?.querySelector('button');
    if (!field || !form || !button) throw new Error('The hero search form is missing');
    expect(field.labels?.[0]?.textContent).toContain('Search events');
    field.value = value;
    let submit: Event | undefined;
    form.addEventListener('submit', (event) => (submit = event));
    button.click();
    await TestBed.inject(ApplicationRef).whenStable();
    if (!submit) throw new Error('The search button did not submit the form');
    return submit;
  }

  it('searching opens the event list with the query', async () => {
    const submit = await searchFor('jazz');

    expect(TestBed.inject(EventSearchStore).query()).toBe('jazz');
    expect(TestBed.inject(Router).url).toBe('/events');
    expect(submit.defaultPrevented).toBe(true);
  });

  it('an empty query opens the full list', async () => {
    await searchFor('', () => TestBed.inject(EventSearchStore).query.set('left over'));

    expect(TestBed.inject(EventSearchStore).query()).toBe('');
    expect(TestBed.inject(Router).url).toBe('/events');
  });
});

describe('StartPage', () => {
  // Every request a test did not answer fails the test.
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('offers the three roles and a way to browse without a login', () => {
    const { element, button } = render();

    expect(button(/customer/i)).toBeDefined();
    expect(button(/organizer/i)).toBeDefined();
    expect(button(/admin/i)).toBeDefined();
    expect(element.querySelector('a[href="/events"]')).not.toBeNull();
  });

  // The e2e specs pick a card by the role name, so no hint may name another role.
  it.each(Object.values(ROLE))('has exactly one button that matches the role %s', (role) => {
    const { element } = render();

    const matching = [...element.querySelectorAll('button')].filter((candidate) =>
      candidate.textContent.toLowerCase().includes(role)
    );
    expect(matching).toHaveLength(1);
  });

  it('posts the role, stores the session and opens the event list', async () => {
    const { http, answer, button } = render();

    button(/organizer/i)?.click();
    TestBed.tick();
    await answer(() => {
      const request = http.expectOne(LOGIN_URL);
      expect(request.request.body).toEqual({ role: ROLE.ORGANIZER });
      request.flush(tokensFor(ROLE.ORGANIZER));
    });

    expect(TestBed.inject(SessionStore).role()).toBe(ROLE.ORGANIZER);
    expect(TestBed.inject(Router).url).toBe('/events');
  });

  it('sends one request for a double click and disables the buttons while it is pending', () => {
    const { element, http, button } = render();

    button(/customer/i)?.click();
    button(/customer/i)?.click();
    TestBed.tick();

    http.expectOne(LOGIN_URL);
    expect(element.querySelector('[role=status]')).not.toBeNull();
    const roleButtons = [
      ...element.querySelectorAll<HTMLButtonElement>('button:not([type=submit])'),
    ];
    expect(roleButtons).toHaveLength(3);
    expect(roleButtons.every((candidate) => candidate.disabled)).toBe(true);
  });

  it('shows the rate-limit text for a 429 and retries the same role', async () => {
    const { element, http, answer, button } = render();
    button(/admin/i)?.click();
    TestBed.tick();
    await answer(() =>
      http.expectOne(LOGIN_URL).flush(null, { status: 429, statusText: 'Too Many Requests' })
    );
    expect(element.querySelector('[role=alert]')?.textContent).toContain('Too many');

    button(/try again/i)?.click();
    TestBed.tick();
    await answer(() => {
      const request = http.expectOne(LOGIN_URL);
      expect(request.request.body).toEqual({ role: ROLE.ADMIN });
      request.flush(tokensFor(ROLE.ADMIN));
    });

    expect(element.querySelector('[role=alert]')).toBeNull();
    expect(TestBed.inject(SessionStore).role()).toBe(ROLE.ADMIN);
  });

  it('says that the demo is full for a 503 and shows a generic text otherwise', async () => {
    const { element, http, answer, button } = render();
    button(/customer/i)?.click();
    TestBed.tick();
    await answer(() =>
      http.expectOne(LOGIN_URL).flush(null, { status: 503, statusText: 'Service Unavailable' })
    );
    expect(element.querySelector('[role=alert]')?.textContent).toContain('full');

    button(/try again/i)?.click();
    TestBed.tick();
    await answer(() =>
      http.expectOne(LOGIN_URL).flush(null, { status: 500, statusText: 'Server Error' })
    );
    expect(element.querySelector('[role=alert]')?.textContent).toContain('could not');
  });
});
