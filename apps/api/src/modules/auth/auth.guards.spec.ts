import { ROLE } from '@app/shared';
import { Controller, Get, type INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_GUARD_PROVIDERS } from './auth.module.js';
import { CurrentUser, OptionalUser, Public, Roles } from './decorators.js';
import type { AuthUser } from './domain/auth-user.js';
import { TOKEN_VERIFIER, type TokenVerifier } from './domain/token-verifier.js';

const CUSTOMER: AuthUser = { id: '11111111-1111-4111-8111-111111111111', roles: [ROLE.CUSTOMER] };
const ORGANIZER: AuthUser = { id: '22222222-2222-4222-8222-222222222222', roles: [ROLE.ORGANIZER] };
const TOKENS = new Map<string, AuthUser>([
  ['customer-token', CUSTOMER],
  ['organizer-token', ORGANIZER],
]);

const fakeVerifier: TokenVerifier = {
  verify(token) {
    const user = TOKENS.get(token);
    return user ? Promise.resolve(user) : Promise.reject(new UnauthorizedException());
  },
};

@Controller('probe')
class ProbeController {
  // No decorator at all: only the default-deny guard protects it.
  @Get('bare')
  bareRoute(): { ok: true } {
    return { ok: true };
  }

  @Get('private')
  privateRoute(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @Public()
  @Get('public')
  publicRoute(@OptionalUser() user: AuthUser | null): { id: string | null } {
    return { id: user?.id ?? null };
  }

  @Roles(ROLE.ORGANIZER)
  @Get('organizer')
  organizerRoute(): { ok: true } {
    return { ok: true };
  }
}

describe('default-deny and role guards', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [...AUTH_GUARD_PROVIDERS, { provide: TOKEN_VERIFIER, useValue: fakeVerifier }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  const get = (path: string, authorization?: string) => {
    const call = request(app.getHttpServer()).get(path);
    return authorization === undefined ? call : call.set('Authorization', authorization);
  };

  it('a route without any decorator needs a token', async () => {
    await get('/probe/bare').expect(401);
  });

  it('a valid token reaches the handler with the verified user', async () => {
    const response = await get('/probe/private', 'Bearer customer-token').expect(200);

    expect(response.body).toEqual(CUSTOMER);
  });

  it('a public route works without a token and sees no user', async () => {
    const response = await get('/probe/public').expect(200);

    expect(response.body).toEqual({ id: null });
  });

  it('a public route sees the user of a valid token', async () => {
    const response = await get('/probe/public', 'Bearer customer-token').expect(200);

    expect(response.body).toEqual({ id: CUSTOMER.id });
  });

  it.each(['Bearer forged-token', 'Basic Y3VzdG9tZXItdG9rZW4=', 'customer-token'])(
    'a public route answers 401 for the bad credential %s',
    async (authorization) => {
      await get('/probe/public', authorization).expect(401);
    }
  );

  it('answers 403 when the user lacks the required role', async () => {
    await get('/probe/organizer', 'Bearer customer-token').expect(403);
  });

  it('answers 200 when the user has the required role', async () => {
    await get('/probe/organizer', 'Bearer organizer-token').expect(200);
  });

  it('answers 401, not 403, when a role route gets no token', async () => {
    await get('/probe/organizer').expect(401);
  });

  it('a bad token never reaches the handler', async () => {
    const response = await get('/probe/private', 'Bearer forged-token').expect(401);

    expect(response.body).not.toHaveProperty('id');
  });
});
