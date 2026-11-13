import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ROLE } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tokensFor } from '../../testing/tokens';
import { authInterceptor } from './auth.interceptor';
import { SessionStore } from './session.store';

const REFRESH_URL = '/api/auth/refresh';
const UNAUTHORIZED = { status: 401, statusText: 'Unauthorized' };
const OLD = tokensFor(ROLE.CUSTOMER, 'old');
const NEW = tokensFor(ROLE.CUSTOMER, 'new');

function setup() {
  const http = TestBed.inject(HttpClient);
  const controller = TestBed.inject(HttpTestingController);
  const store = TestBed.inject(SessionStore);
  const statuses: (number | 'ok')[] = [];
  const get = (url: string) =>
    http.get(url).subscribe({
      next: () => statuses.push('ok'),
      error: (error: { status: number }) => statuses.push(error.status),
    });
  return { controller, store, statuses, get };
}

describe('authInterceptor', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([
          { path: '', children: [] },
          { path: 'events', children: [] },
        ]),
      ],
    })
  );
  // Every request a test did not answer fails the test.
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('adds the bearer token to API calls and sends no header without a session', () => {
    const { controller, store, get } = setup();

    get('/api/events');
    expect(controller.expectOne('/api/events').request.headers.has('Authorization')).toBe(false);

    store.set(OLD);
    get('/api/events');
    expect(controller.expectOne('/api/events').request.headers.get('Authorization')).toBe(
      `Bearer ${OLD.accessToken}`
    );
  });

  it('adds no token to the two auth routes or to calls outside /api', () => {
    const { controller, store, get } = setup();
    store.set(OLD);

    for (const url of ['/api/demo-login', REFRESH_URL, '/assets/other.json']) {
      get(url);
      expect(controller.expectOne(url).request.headers.has('Authorization')).toBe(false);
    }
  });

  it('refreshes once on 401 and retries the request with the new token', () => {
    const { controller, store, statuses, get } = setup();
    store.set(OLD);

    get('/api/bookings');
    controller.expectOne('/api/bookings').flush(null, UNAUTHORIZED);
    const refresh = controller.expectOne(REFRESH_URL);
    expect(refresh.request.body).toEqual({ refreshToken: OLD.refreshToken });
    refresh.flush(NEW);
    const retry = controller.expectOne('/api/bookings');
    expect(retry.request.headers.get('Authorization')).toBe(`Bearer ${NEW.accessToken}`);
    retry.flush([]);

    expect(statuses).toEqual(['ok']);
    expect(store.session()?.refreshToken).toBe(NEW.refreshToken);
  });

  it('refreshes again later with the newest refresh token', () => {
    const { controller, store, statuses, get } = setup();
    const newest = tokensFor(ROLE.CUSTOMER, 'newest');
    store.set(OLD);

    get('/api/bookings');
    controller.expectOne('/api/bookings').flush(null, UNAUTHORIZED);
    controller.expectOne(REFRESH_URL).flush(NEW);
    controller.expectOne('/api/bookings').flush([]);
    get('/api/bookings');
    controller.expectOne('/api/bookings').flush(null, UNAUTHORIZED);
    const second = controller.expectOne(REFRESH_URL);
    expect(second.request.body).toEqual({ refreshToken: NEW.refreshToken });
    second.flush(newest);
    controller.expectOne('/api/bookings').flush([]);

    expect(statuses).toEqual(['ok', 'ok']);
  });

  it('shares one refresh between two concurrent 401s', () => {
    const { controller, store, statuses, get } = setup();
    store.set(OLD);

    get('/api/bookings');
    get('/api/organizer/events');
    controller.expectOne('/api/bookings').flush(null, UNAUTHORIZED);
    controller.expectOne('/api/organizer/events').flush(null, UNAUTHORIZED);
    controller.expectOne(REFRESH_URL).flush(NEW);
    controller.expectOne('/api/bookings').flush([]);
    controller.expectOne('/api/organizer/events').flush([]);

    expect(statuses).toEqual(['ok', 'ok']);
  });

  it('retries a 401 that was answered after the refresh with the new token, without a second refresh', () => {
    const { controller, store, statuses, get } = setup();
    store.set(OLD);

    get('/api/bookings');
    get('/api/organizer/events');
    controller.expectOne('/api/bookings').flush(null, UNAUTHORIZED);
    controller.expectOne(REFRESH_URL).flush(NEW);
    controller.expectOne('/api/bookings').flush([]);
    controller.expectOne('/api/organizer/events').flush(null, UNAUTHORIZED);
    const retry = controller.expectOne('/api/organizer/events');
    expect(retry.request.headers.get('Authorization')).toBe(`Bearer ${NEW.accessToken}`);
    retry.flush([]);

    expect(statuses).toEqual(['ok', 'ok']);
  });

  it('clears the session and returns to the start page when the refresh fails', async () => {
    const { controller, store, statuses, get } = setup();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/events');
    store.set(OLD);

    get('/api/bookings');
    controller.expectOne('/api/bookings').flush(null, UNAUTHORIZED);
    controller.expectOne(REFRESH_URL).flush(null, UNAUTHORIZED);
    await TestBed.inject(ApplicationRef).whenStable();

    expect(statuses).toEqual([401]);
    expect(store.isLoggedIn()).toBe(false);
    expect(router.url).toBe('/');
  });

  it('returns a second 401 after the retry instead of refreshing again', () => {
    const { controller, store, statuses, get } = setup();
    store.set(OLD);

    get('/api/bookings');
    controller.expectOne('/api/bookings').flush(null, UNAUTHORIZED);
    controller.expectOne(REFRESH_URL).flush(NEW);
    controller.expectOne('/api/bookings').flush(null, UNAUTHORIZED);

    expect(statuses).toEqual([401]);
  });

  it('does not refresh a 401 that carried no token', () => {
    const { controller, statuses, get } = setup();

    get('/api/events');
    controller.expectOne('/api/events').flush(null, UNAUTHORIZED);

    expect(statuses).toEqual([401]);
  });

  it('passes other errors through without refreshing', () => {
    const { controller, store, statuses, get } = setup();
    store.set(OLD);

    get('/api/bookings');
    controller.expectOne('/api/bookings').flush(null, { status: 403, statusText: 'Forbidden' });

    expect(statuses).toEqual([403]);
  });
});
