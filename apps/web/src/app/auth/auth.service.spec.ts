import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ROLE } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tokensFor } from '../../testing/tokens';
import { AuthService } from './auth.service';
import { SessionStore } from './session.store';

describe('AuthService', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '', children: [] }]),
      ],
    })
  );
  // Every request a test did not answer fails the test.
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('demoLogin posts the role and stores the session', () => {
    const http = TestBed.inject(HttpTestingController);
    let done = false;
    TestBed.inject(AuthService)
      .demoLogin(ROLE.ADMIN)
      .subscribe(() => (done = true));

    const request = http.expectOne('/api/demo-login');
    expect(request.request.body).toEqual({ role: ROLE.ADMIN });
    request.flush(tokensFor(ROLE.ADMIN));

    expect(done).toBe(true);
    expect(TestBed.inject(SessionStore).role()).toBe(ROLE.ADMIN);
  });

  it('rejects a login answer that does not match the contract and stores nothing', () => {
    const http = TestBed.inject(HttpTestingController);
    let failed = false;
    TestBed.inject(AuthService)
      .demoLogin(ROLE.CUSTOMER)
      .subscribe({ error: () => (failed = true) });

    const { expiresIn: _unused, ...incomplete } = tokensFor(ROLE.CUSTOMER);
    http.expectOne('/api/demo-login').flush(incomplete);

    expect(failed).toBe(true);
    expect(TestBed.inject(SessionStore).isLoggedIn()).toBe(false);
  });

  it('logout clears the session and returns to the start page', async () => {
    TestBed.inject(SessionStore).set(tokensFor(ROLE.CUSTOMER));
    const router = TestBed.inject(Router);

    await TestBed.inject(AuthService).logout();

    expect(TestBed.inject(SessionStore).isLoggedIn()).toBe(false);
    expect(router.url).toBe('/');
  });
});
