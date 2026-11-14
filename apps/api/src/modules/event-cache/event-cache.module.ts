import { Module } from '@nestjs/common';

import { CacheModule } from '../../infrastructure/cache/index.js';
import { EventCache } from './event-cache.js';

@Module({ imports: [CacheModule], providers: [EventCache], exports: [EventCache] })
export class EventCacheModule {}
