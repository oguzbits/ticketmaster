import { computed, Injectable, signal } from '@angular/core';
import {
  AccessTokenClaimsSchema,
  type Role,
  RoleSchema,
  type TokenResponse,
  TokenResponseSchema,
} from '@app/shared';

const STORAGE_KEY = 'session';

const SessionSchema = TokenResponseSchema.extend({ role: RoleSchema });
type Session = TokenResponse & { role: Role };

/**
 * The realm role in the access token, for display only: the signature is not checked here and the
 * server decides on every request. A token without one of our roles is refused.
 */
function roleOf(accessToken: string): Role {
  const payload = (accessToken.split('.')[1] ?? '').replaceAll('-', '+').replaceAll('_', '/');
  const { roles } = AccessTokenClaimsSchema.parse(JSON.parse(atob(payload))).realm_access;
  const role = roles.map((name) => RoleSchema.safeParse(name)).find((parsed) => parsed.success);
  if (!role) throw new Error('The access token carries no known role');
  return role.data;
}

/** Holds the session in memory and mirrors it into sessionStorage so a reload keeps it. */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  readonly session = signal<Session | null>(this.restore());
  readonly isLoggedIn = computed(() => this.session() !== null);
  readonly role = computed(() => this.session()?.role ?? null);
  readonly accessToken = computed(() => this.session()?.accessToken ?? null);

  set(tokens: TokenResponse): void {
    const session: Session = { ...tokens, role: roleOf(tokens.accessToken) };
    this.session.set(session);
    this.persist(() => sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session)));
  }

  clear(): void {
    this.session.set(null);
    this.persist(() => sessionStorage.removeItem(STORAGE_KEY));
  }

  private restore(): Session | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw === null ? null : (SessionSchema.safeParse(JSON.parse(raw)).data ?? null);
    } catch (_blocked) {
      // Blocked storage or unreadable data: start logged out, the user logs in again.
      return null;
    }
  }

  private persist(write: () => void): void {
    try {
      write();
    } catch (_blocked) {
      // Blocked storage (private mode, site data off): the session lives in memory only.
    }
  }
}
