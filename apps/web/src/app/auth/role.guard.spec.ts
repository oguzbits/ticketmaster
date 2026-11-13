import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ROLE } from '@app/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { tokensFor } from '../../testing/tokens';
import { roleGuard } from './role.guard';
import { SessionStore } from './session.store';

async function visitProtectedRoute() {
  const router = TestBed.inject(Router);
  await router.navigateByUrl('/protected');
  return router.url;
}

describe('roleGuard', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', children: [] },
          { path: 'events', children: [] },
          { path: 'protected', canActivate: [roleGuard(ROLE.ADMIN, ROLE.ORGANIZER)], children: [] },
        ]),
      ],
    })
  );

  it('sends a visitor without a session to the start page', async () => {
    expect(await visitProtectedRoute()).toBe('/');
  });

  it('sends a user with the wrong role to the event list', async () => {
    TestBed.inject(SessionStore).set(tokensFor(ROLE.CUSTOMER));
    expect(await visitProtectedRoute()).toBe('/events');
  });

  it('lets a user with one of the roles through', async () => {
    TestBed.inject(SessionStore).set(tokensFor(ROLE.ORGANIZER));
    expect(await visitProtectedRoute()).toBe('/protected');
  });
});
