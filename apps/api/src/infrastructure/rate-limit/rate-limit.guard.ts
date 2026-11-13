import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthUser } from '../../modules/auth/index.js';
import { RATE_LIMIT, RATE_LIMIT_KEY, type RateLimitName } from './rate-limit.decorator.js';
import { RateLimiter } from './rate-limiter.js';

/** The part of the HTTP request and response the guard uses. */
interface LimitedRequest {
  ip?: string;
  user?: AuthUser;
}
interface LimitedResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Must run after the auth guards, so `request.user` is set: it counts the named limit (default:
 * `DEFAULT`) per IP and, for a signed-in caller, `DEFAULT` per user. `request.ip` is the last
 * proxy hop (see `configureApp`), so a forged `X-Forwarded-For` prefix changes nothing.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const { ip, user } = http.getRequest<LimitedRequest>();
    if (ip === undefined) throw new Error('The request has no client address');
    const name =
      this.reflector.getAllAndOverride<RateLimitName | undefined>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'DEFAULT';

    const response = http.getResponse<LimitedResponse>();
    await this.count(response, `rl:${name}:ip:${ip}`, name);
    if (user) await this.count(response, `rl:DEFAULT:user:${user.id}`, 'DEFAULT');
    return true;
  }

  private async count(response: LimitedResponse, key: string, name: RateLimitName): Promise<void> {
    const { limit, windowSeconds } = RATE_LIMIT[name];
    const { allowed, retryAfterSeconds } = await this.limiter.hit(key, limit, windowSeconds);
    if (allowed) return;
    response.setHeader('Retry-After', String(retryAfterSeconds));
    throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
  }
}
