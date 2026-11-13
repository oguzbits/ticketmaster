import { type Role, type TokenResponse } from '@app/shared';
import { UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import type { Clock } from '../../../core/clock.js';
import type { KeycloakAdmin, NewDemoUser } from '../domain/demo-user.js';

export interface KeycloakAdminConfig {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

const GRANT = {
  CLIENT_CREDENTIALS: 'client_credentials',
  PASSWORD: 'password',
  REFRESH_TOKEN: 'refresh_token',
} as const;

/** Without this scope Keycloak answers the admin API with 401. Only the admin token asks for it. */
const ADMIN_API_SCOPE = 'kc-admin-api';
/** The admin token is renewed this long before Keycloak would refuse it. */
const ADMIN_TOKEN_MARGIN_MS = 10_000;
const HTTP = { NOT_FOUND: 404, BAD_REQUEST: 400, UNAUTHORIZED: 401 } as const;

const TokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number().int().positive(),
});
const AdminTokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().int().positive(),
});
const RolesSchema = z.array(z.object({ id: z.string(), name: z.string() }));

/** Keycloak over HTTP: admin calls through the service account of the confidential client. */
export class KeycloakAdminClient implements KeycloakAdmin {
  private adminToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: KeycloakAdminConfig,
    private readonly clock: Clock
  ) {}

  async createUser(input: NewDemoUser): Promise<string> {
    const { role, password, ...profile } = input;
    const response = await this.admin('POST', '/users', {
      ...profile,
      enabled: true,
      credentials: [{ type: 'password', value: password, temporary: false }],
    });
    const location = response.headers.get('location');
    const id = z.uuid().parse(location?.split('/').at(-1));
    try {
      await this.mapRole(id, role);
    } catch (error) {
      // The caller never learns the ID, so nobody else could delete the half-made user.
      await this.deleteUser(id);
      throw error;
    }
    return id;
  }

  async deleteUser(id: string): Promise<void> {
    await this.admin('DELETE', `/users/${id}`, undefined, [HTTP.NOT_FOUND]);
  }

  passwordGrant(username: string, password: string): Promise<TokenResponse> {
    return this.userTokens({ grant_type: GRANT.PASSWORD, username, password });
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    return this.userTokens({ grant_type: GRANT.REFRESH_TOKEN, refresh_token: refreshToken }, [
      HTTP.BAD_REQUEST,
      HTTP.UNAUTHORIZED,
    ]);
  }

  /** `realmRoles` in the create request is ignored, and the role cannot be read by name (403). */
  private async mapRole(userId: string, role: Role): Promise<void> {
    const path = `/users/${userId}/role-mappings/realm`;
    const available = RolesSchema.parse(
      await (await this.admin('GET', `${path}/available`)).json()
    );
    const wanted = available.find(({ name }) => name === role);
    if (wanted === undefined) throw new Error(`Keycloak does not offer the realm role ${role}`);
    await this.admin('POST', path, [wanted]);
  }

  /** `rejected`: statuses that mean the caller's credential is bad (401 for them), not a failure of ours. */
  private async userTokens(
    form: Record<string, string>,
    rejected: readonly number[] = []
  ): Promise<TokenResponse> {
    const response = await this.tokenRequest({
      ...form,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    if (rejected.includes(response.status)) throw new UnauthorizedException();
    if (!response.ok) throw new Error(`Keycloak token request answered ${response.status}`);
    const tokens = TokenSchema.parse(await response.json());
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
    };
  }

  private tokenRequest(form: Record<string, string>): Promise<Response> {
    const { baseUrl, realm } = this.config;
    return fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams(form),
    });
  }

  private async getAdminToken(): Promise<string> {
    const now = this.clock.now().getTime();
    if (this.adminToken !== null && now < this.adminToken.expiresAt) return this.adminToken.value;
    const response = await this.tokenRequest({
      grant_type: GRANT.CLIENT_CREDENTIALS,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: ADMIN_API_SCOPE,
    });
    if (!response.ok) throw new Error(`Keycloak admin token request answered ${response.status}`);
    const token = AdminTokenSchema.parse(await response.json());
    this.adminToken = {
      value: token.access_token,
      expiresAt: now + token.expires_in * 1000 - ADMIN_TOKEN_MARGIN_MS,
    };
    return token.access_token;
  }

  /** `tolerated`: statuses that count as success besides the 2xx ones. */
  private async admin(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: object,
    tolerated: readonly number[] = []
  ): Promise<Response> {
    const { baseUrl, realm } = this.config;
    const response = await fetch(`${baseUrl}/admin/realms/${realm}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.getAdminToken()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok && !tolerated.includes(response.status)) {
      throw new Error(`Keycloak ${method} ${path} answered ${response.status}`);
    }
    return response;
  }
}
