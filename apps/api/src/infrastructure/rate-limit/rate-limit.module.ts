import { Module } from '@nestjs/common';

import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimiter } from './rate-limiter.js';
import { SlotLimiter } from './slot-limiter.js';

@Module({
  providers: [RateLimiter, RateLimitGuard, SlotLimiter],
  exports: [RateLimiter, RateLimitGuard, SlotLimiter],
})
export class RateLimitModule {}
