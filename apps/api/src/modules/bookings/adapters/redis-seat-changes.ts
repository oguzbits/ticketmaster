import type { SeatChange } from '@app/shared';

import type { Redis } from '../../../infrastructure/redis/redis.module.js';
import { type SeatChangePublisher, seatChannel } from '../domain/seat-change.js';

/** Redis pub/sub: fire and forget, a viewer that is not subscribed misses the message. */
export class RedisSeatChangePublisher implements SeatChangePublisher {
  constructor(private readonly redis: Redis) {}

  async publish(change: SeatChange): Promise<void> {
    await this.redis.publish(seatChannel(change.eventId), JSON.stringify(change));
  }
}
