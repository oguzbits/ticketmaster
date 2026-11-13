import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { type Role, TokenResponseSchema } from '@app/shared';
import { finalize, map, type Observable, share, tap, throwError } from 'rxjs';

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

  logout(): Promise<boolean> {
    this.store.clear();
    return this.router.navigateByUrl('/');
  }
}
