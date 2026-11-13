import { HEALTH_STATUS, type HealthResponse, OUTBOX_SIGNAL } from '@app/shared';
import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { Public } from '../auth/index.js';
import { OUTBOX_STUCK_SECONDS, OutboxService } from '../outbox/index.js';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(OutboxService) private readonly outbox: OutboxService
  ) {}

  @Public()
  @Get('live')
  live(): HealthResponse {
    return { status: HEALTH_STATUS.UP };
  }

  /**
   * Ready when Postgres answers `select 1` and Redis answers PING; 503 otherwise. The outbox signal
   * is `stuck` when the oldest unpublished row is older than OUTBOX_STUCK_SECONDS (the worker or
   * the queue is down), but the status stays 200: an API instance still serves every request, and
   * a worker outage must not make the proxy drop the instances.
   */
  @Public()
  @Get('ready')
  async ready(): Promise<HealthResponse> {
    let oldestAgeSeconds: number | null;
    try {
      [, , oldestAgeSeconds] = await Promise.all([
        this.db.execute(sql`select 1`),
        this.redis.ping(),
        this.outbox.oldestUnpublishedAgeSeconds(),
      ]);
    } catch (error) {
      this.logger.warn(`not ready: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new ServiceUnavailableException({ status: HEALTH_STATUS.DOWN });
    }
    const stuck = oldestAgeSeconds !== null && oldestAgeSeconds > OUTBOX_STUCK_SECONDS;
    return {
      status: HEALTH_STATUS.UP,
      signals: { outbox: stuck ? OUTBOX_SIGNAL.STUCK : OUTBOX_SIGNAL.OK },
    };
  }
}
