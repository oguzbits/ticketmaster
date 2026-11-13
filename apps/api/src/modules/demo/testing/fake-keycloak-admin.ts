import { randomUUID } from 'node:crypto';

import type { TokenResponse } from '@app/shared';

import type { KeycloakAdmin, NewDemoUser } from '../domain/demo-user.js';

export const FAKE_TOKENS: TokenResponse = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresIn: 300,
};

/** A Keycloak that remembers what it was asked and fails on demand. */
export class FakeKeycloakAdmin implements KeycloakAdmin {
  readonly created: (NewDemoUser & { id: string })[] = [];
  readonly deleted: string[] = [];
  readonly refreshed: string[] = [];
  failGrant = false;
  /** IDs whose deletion fails. */
  readonly failDelete = new Set<string>();

  createUser(input: NewDemoUser): Promise<string> {
    const id = randomUUID();
    this.created.push({ ...input, id });
    return Promise.resolve(id);
  }

  deleteUser(id: string): Promise<void> {
    if (this.failDelete.has(id)) return Promise.reject(new Error('Keycloak is down'));
    this.deleted.push(id);
    return Promise.resolve();
  }

  passwordGrant(): Promise<TokenResponse> {
    return this.failGrant
      ? Promise.reject(new Error('grant refused'))
      : Promise.resolve(FAKE_TOKENS);
  }

  refresh(refreshToken: string): Promise<TokenResponse> {
    this.refreshed.push(refreshToken);
    return Promise.resolve(FAKE_TOKENS);
  }
}
