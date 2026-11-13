import type { Role } from '@app/shared';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { type AuthenticatedRequest, ROLES_KEY } from './decorators.js';

/** Runs after `JwtAuthGuard`: a route with `@Roles()` needs one of them, otherwise 403. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) return true;
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return user !== undefined && required.some((role) => user.roles.includes(role));
  }
}
