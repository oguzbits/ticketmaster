import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { type Role, TokenResponseSchema } from '@app/shared';
import { catchError, finalize, map, type Observable, of, share, tap, throwError } from 'rxjs';

import { SessionStore } from './session.store';

export const DEMO_LOGIN_URL = '/api/demo-login';
export const REFRESH_URL = '/api/auth/refresh';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly store = inject(SessionStore);
  private readonly router = inject(Router);

  /** The refresh that is running now, so concurrent callers share one (refresh tokens are single-use). */
  private inFlightRefresh: Observable<string> | null = null;

  demoLogin(role: Role): Observable<void> {
    return this.http.post(DEMO_LOGIN_URL, { role }).pipe(
      map((body) => TokenResponseSchema.parse(body)),
      tap((tokens) => this.store.set(tokens)),
      map(() => undefined)
    );
  }

  /** Renews the tokens and emits the new access token. */
  refresh(): Observable<string> {
    const session = this.store.session();
    if (!session) return throwError(() => new Error('No session to refresh'));
    this.inFlightRefresh ??= this.http
      .post(REFRESH_URL, { refreshToken: session.refreshToken })
      .pipe(
        map((body) => TokenResponseSchema.parse(body)),
        tap((tokens) => this.store.set(tokens)),
        map((tokens) => tokens.accessToken),
        finalize(() => (this.inFlightRefresh = null)),
        share()
      );
    return this.inFlightRefresh;
  }

  /**
   * The token to repeat a request with after the server answered 401 to `rejectedToken`. A newer
   * token means another call already refreshed (the refresh token is single-use, so spending it a
   * second time would end the session); otherwise the tokens are renewed. A failed refresh ends
   * the session.
   */
  renewAfterUnauthorized(rejectedToken: string): Observable<string> {
    const current = this.store.accessToken();
    if (current !== null && current !== rejectedToken) return of(current);
    return this.refresh().pipe(
      catchError((error) => {
        void this.logout();
        return throwError(() => error);
      })
    );
  }

  logout(): Promise<boolean> {
    this.store.clear();
    return this.router.navigateByUrl('/');
  }
}
