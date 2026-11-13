import type { Role } from '@app/shared';
import {
  createParamDecorator,
  type CustomDecorator,
  type ExecutionContext,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';

import type { AuthUser } from './domain/auth-user.js';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

/** The part of the HTTP request the auth guards read and write. */
export interface AuthenticatedRequest {
  headers: { authorization?: string };
  user?: AuthUser;
}

/** Opts a route out of the default-deny guard. A token that is sent is still verified. */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** The caller needs one of these roles; a route without it allows any authenticated user. */
export const Roles = (...roles: Role[]): CustomDecorator => SetMetadata(ROLES_KEY, roles);

function requestOf(context: ExecutionContext): AuthenticatedRequest {
  return context.switchToHttp().getRequest<AuthenticatedRequest>();
}

/** The verified user. Fails fast when no guard attached one (a route that is public). */
export const CurrentUser = createParamDecorator((_data: undefined, context: ExecutionContext) => {
  const { user } = requestOf(context);
  if (!user) throw new UnauthorizedException();
  return user;
});

/** The verified user of a public route, or null when the request carries no token. */
export const OptionalUser = createParamDecorator(
  (_data: undefined, context: ExecutionContext): AuthUser | null => requestOf(context).user ?? null
);
