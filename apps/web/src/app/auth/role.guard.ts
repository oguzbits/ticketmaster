import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import type { Role } from '@app/shared';

import { SessionStore } from './session.store';

/** Not signed in: back to the start page. Wrong role: the event list. The server checks again. */
export function roleGuard(...roles: Role[]): CanActivateFn {
  return () => {
    const router = inject(Router);
    const role = inject(SessionStore).role();
    if (role === null) return router.parseUrl('/');
    return roles.includes(role) ? true : router.parseUrl('/events');
  };
}
