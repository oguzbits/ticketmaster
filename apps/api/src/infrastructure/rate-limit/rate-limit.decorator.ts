import { type CustomDecorator, SetMetadata } from '@nestjs/common';

export const RATE_LIMIT = {
  DEFAULT: { limit: 120, windowSeconds: 60 },
  DEMO_LOGIN: { limit: 5, windowSeconds: 60 },
  REFRESH: { limit: 30, windowSeconds: 60 },
  CREATE_EVENT: { limit: 10, windowSeconds: 60 },
} as const;

export type RateLimitName = keyof typeof RATE_LIMIT;

export const RATE_LIMIT_KEY = 'rateLimit';

/** Swaps the default per-IP limit of a route for a named, stricter one. */
export const RateLimit = (name: RateLimitName): CustomDecorator =>
  SetMetadata(RATE_LIMIT_KEY, name);
