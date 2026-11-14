import { Module } from '@nestjs/common';

import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { AuditModule } from '../audit/index.js';
import { RedisWaitingRoomStore } from './adapters/redis-waiting-room-store.js';
import { WAITING_ROOM_STORE } from './domain/waiting-room-store.js';
import { WaitingRoomController } from './waiting-room.controller.js';
import { WaitingRoomService } from './waiting-room.service.js';
import { WaitingRoomStreamService } from './waiting-room-stream.service.js';

@Module({
  imports: [AuditModule, RateLimitModule],
  controllers: [WaitingRoomController],
  providers: [
    WaitingRoomService,
    WaitingRoomStreamService,
    {
      provide: WAITING_ROOM_STORE,
      useFactory: (redis: Redis) => new RedisWaitingRoomStore(redis),
      inject: [REDIS],
    },
  ],
  exports: [WaitingRoomService, WAITING_ROOM_STORE],
})
export class WaitingRoomModule {}
