import { HEALTH_STATUS, type HealthResponse } from '@app/shared';
import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { Public } from '../auth/index.js';

@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis
  ) {}

  @Get('live')
  live(): HealthResponse {
    return { status: HEALTH_STATUS.UP };
  }

  /** Ready when Postgres answers `select 1` and Redis answers PING; 503 otherwise. */
  @Get('ready')
  async ready(): Promise<HealthResponse> {
    try {
      await Promise.all([this.db.execute(sql`select 1`), this.redis.ping()]);
    } catch (error) {
      this.logger.warn(`not ready: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new ServiceUnavailableException({ status: HEALTH_STATUS.DOWN });
    }
    return { status: HEALTH_STATUS.UP };
  }
}
