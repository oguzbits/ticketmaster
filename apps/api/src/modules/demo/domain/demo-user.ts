import type { Role, TokenResponse } from '@app/shared';

export const KEYCLOAK_ADMIN = Symbol('KEYCLOAK_ADMIN');

export interface NewDemoUser {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  role: Role;
}

/** What the demo login needs from Keycloak. An adapter implements it. */
export interface KeycloakAdmin {
  /** Creates the user with its realm role and returns its ID (the `sub` of its tokens). */
  createUser(input: NewDemoUser): Promise<string>;
  /** A user that is already gone counts as deleted; any other failure throws. */
  deleteUser(id: string): Promise<void>;
  passwordGrant(username: string, password: string): Promise<TokenResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
}

/**
 * Keycloak refuses a password grant for a user without email, first and last name ("Account is not
 * fully set up"). The address is on the reserved `.invalid` domain, so no mail can ever be sent.
 */
export function demoIdentity(suffix: string): Omit<NewDemoUser, 'password' | 'role'> {
  return {
    username: `demo-${suffix}`,
    email: `demo-${suffix}@demo.invalid`,
    firstName: 'Demo',
    lastName: 'User',
  };
}
