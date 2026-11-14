import { Module } from '@nestjs/common';

import { CacheAside } from './cache-aside.js';

/** Redis and the business metrics are global modules, so the cache needs no imports. */
@Module({ providers: [CacheAside], exports: [CacheAside] })
export class CacheModule {}
