import { HttpErrorResponse, type HttpInterceptorFn, HttpStatusCode } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';

import { AuthService, DEMO_LOGIN_URL, REFRESH_URL } from './auth.service';
import { SessionStore } from './session.store';

const UNAUTHENTICATED_URLS: readonly string[] = [DEMO_LOGIN_URL, REFRESH_URL];

/**
 * Adds the bearer token to API calls. A 401 refreshes the tokens once and repeats the request once;
 * a second 401 goes to the caller, a failed refresh ends the session.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/') || UNAUTHENTICATED_URLS.includes(request.url)) {
    return next(request);
  }
  const auth = inject(AuthService);
  const store = inject(SessionStore);
  const send = (token: string | null) =>
    next(token ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request);

  const sentWith = store.accessToken();
  return send(sentWith).pipe(
    catchError((error) => {
      const unauthorized =
        error instanceof HttpErrorResponse && error.status === HttpStatusCode.Unauthorized;
      // Without a token there is nothing to renew.
      if (!unauthorized || sentWith === null) return throwError(() => error);

      return auth.renewAfterUnauthorized(sentWith).pipe(switchMap((token) => send(token)));
    })
  );
};
