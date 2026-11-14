import { type Role, type TokenResponse } from '@app/shared';
import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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
/** Longest wait for one Keycloak answer; a login or refresh must not hang on a stuck Keycloak. */
export const KEYCLOAK_TIMEOUT_MS = 5000;
const HTTP = { NOT_FOUND: 404, BAD_REQUEST: 400, SERVER_ERROR: 500 } as const;
/** The only error code of Keycloak's token endpoint that means "this refresh token is bad". */
const INVALID_GRANT = 'invalid_grant';

const TokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number().int().positive(),
});
const AdminTokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().int().positive(),
});
const TokenErrorSchema = z.object({ error: z.string() });
const UserSchema = z.object({ email: z.string().optional() });
const RolesSchema = z.array(z.object({ id: z.string(), name: z.string() }));

/** Keycloak over HTTP: admin calls through the service account of the confidential client. */
export class KeycloakAdminClient implements KeycloakAdmin {
  private readonly logger = new Logger(KeycloakAdminClient.name);
  private adminToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: KeycloakAdminConfig,
    private readonly clock: Clock,
    private readonly timeoutMs: number = KEYCLOAK_TIMEOUT_MS
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

  async emailOf(userId: string): Promise<string> {
    const { email } = UserSchema.parse(await (await this.admin('GET', `/users/${userId}`)).json());
    if (email === undefined || email === '')
      throw new Error(`Keycloak user ${userId} has no email`);
    return email;
  }

  passwordGrant(username: string, password: string): Promise<TokenResponse> {
    return this.userTokens({ grant_type: GRANT.PASSWORD, username, password });
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    return this.userTokens({ grant_type: GRANT.REFRESH_TOKEN, refresh_token: refreshToken }, true);
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

  /** `badTokenIs401`: Keycloak's `invalid_grant` means the caller's token is bad, not a failure of ours. */
  private async userTokens(
    form: Record<string, string>,
    badTokenIs401 = false
  ): Promise<TokenResponse> {
    const response = await this.tokenRequest({
      ...form,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    if (!response.ok) throw await this.tokenFailure(response, badTokenIs401);
    const tokens = TokenSchema.parse(await response.json());
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
    };
  }

  /**
   * Anything but `invalid_grant` is ours to fix (a wrong client secret answers 401 `invalid_client`,
   * which must not look like a bad token): 503 when Keycloak fails, 500 otherwise, status logged.
   */
  private async tokenFailure(response: Response, badTokenIs401: boolean): Promise<Error> {
    const body = TokenErrorSchema.safeParse(await response.json().catch(() => null));
    if (
      badTokenIs401 &&
      response.status === HTTP.BAD_REQUEST &&
      body.data?.error === INVALID_GRANT
    ) {
      return new UnauthorizedException();
    }
    this.logger.error(`Keycloak token request answered ${response.status}`);
    return response.status >= HTTP.SERVER_ERROR
      ? new ServiceUnavailableException()
      : new Error(`Keycloak token request answered ${response.status}`);
  }

  /** Every call to Keycloak goes through here: a call that outlasts the timeout answers 503. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'TimeoutError') throw error;
      this.logger.error(
        `Keycloak did not answer ${init.method} ${url} within ${this.timeoutMs} ms`
      );
      throw new ServiceUnavailableException();
    }
  }

  private tokenRequest(form: Record<string, string>): Promise<Response> {
    const { baseUrl, realm } = this.config;
    return this.send(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
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
    const response = await this.send(`${baseUrl}/admin/realms/${realm}${path}`, {
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
