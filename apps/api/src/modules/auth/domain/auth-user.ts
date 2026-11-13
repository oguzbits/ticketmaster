import type { Role } from '@app/shared';

/** The caller of a request, taken from a verified token and from nothing the client sends. */
export interface AuthUser {
  id: string;
  roles: Role[];
}
