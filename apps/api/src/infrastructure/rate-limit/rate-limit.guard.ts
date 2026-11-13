import { isIPv6 } from 'node:net';

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

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const IPV6_GROUPS = 8;
const PREFIX_GROUPS = 4;

/**
 * The address a limit counts. An IPv4 address (also IPv4-mapped IPv6) counts alone; an IPv6 client
 * usually owns a whole /64, so its four prefix groups count together, else it could change address
 * at will.
 */
export function rateLimitAddress(ip: string): string {
  const mapped = IPV4_MAPPED.exec(ip)?.[1];
  if (mapped !== undefined) return mapped;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail = ''] = (ip.split('%')[0] ?? ip).split('::');
  // A dotted tail ("64:ff9b::1.2.3.4") stands for two groups; only the count matters there.
  const groups = (part: string): string[] =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group]));
  const [first, last] = [groups(head), groups(tail)];
  const filler = Array<string>(Math.max(IPV6_GROUPS - first.length - last.length, 0)).fill('0');
  const prefix = [...first, ...filler, ...last]
    .slice(0, PREFIX_GROUPS)
    .map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

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
    await this.count(response, `rl:${name}:ip:${rateLimitAddress(ip)}`, name);
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
