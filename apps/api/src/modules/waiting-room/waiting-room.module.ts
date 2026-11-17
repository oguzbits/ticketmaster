import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { AuditModule } from '../audit/index.js';
import { EventCacheModule } from '../event-cache/index.js';
import { HmacAdmissionTokenAdapter } from './adapters/hmac-admission-token.js';
import { RedisWaitingRoomStore } from './adapters/redis-waiting-room-store.js';
import { ADMISSION_TOKENS } from './domain/admission-token.js';
import { WAITING_ROOM_STORE } from './domain/waiting-room-store.js';
import { WaitingRoomController } from './waiting-room.controller.js';
import { WaitingRoomService } from './waiting-room.service.js';
import { WaitingRoomStreamService } from './waiting-room-stream.service.js';

@Module({
  imports: [AuditModule, EventCacheModule, RateLimitModule],
  controllers: [WaitingRoomController],
  providers: [
    WaitingRoomService,
    WaitingRoomStreamService,
    {
      provide: WAITING_ROOM_STORE,
      useFactory: (redis: Redis) => new RedisWaitingRoomStore(redis),
      inject: [REDIS],
    },
    {
      provide: ADMISSION_TOKENS,
      useFactory: (env: Env) => new HmacAdmissionTokenAdapter(env.WAITING_ROOM_SIGNING_SECRET),
      inject: [APP_CONFIG],
    },
  ],
  exports: [WaitingRoomService, WAITING_ROOM_STORE, ADMISSION_TOKENS],
})
export class WaitingRoomModule {}
