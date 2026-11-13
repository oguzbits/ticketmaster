import { Module } from '@nestjs/common';

import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimiter } from './rate-limiter.js';

@Module({ providers: [RateLimiter, RateLimitGuard], exports: [RateLimiter, RateLimitGuard] })
export class RateLimitModule {}
