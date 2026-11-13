import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { type AuthenticatedRequest, IS_PUBLIC_KEY } from './decorators.js';
import { TOKEN_VERIFIER, type TokenVerifier } from './domain/token-verifier.js';

const BEARER_PREFIX = /^Bearer (\S+)$/i;

/**
 * Default-deny: every route needs a verified bearer token unless it is `@Public()`. A public route
 * that receives a token verifies it all the same: a bad token is a 401, never a silent anonymous
 * request.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (header === undefined) {
      if (this.isPublic(context)) return true;
      throw new UnauthorizedException();
    }
    const token = BEARER_PREFIX.exec(header)?.[1];
    if (token === undefined) throw new UnauthorizedException();
    request.user = await this.verifier.verify(token);
    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}
