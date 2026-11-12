import { HEALTH_STATUS, HealthResponseSchema } from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigModule } from '../../config/config.module.js';
import { DatabaseModule, DB } from '../../infrastructure/database/database.module.js';
import { REDIS, RedisModule } from '../../infrastructure/redis/redis.module.js';
import { HealthModule } from './health.module.js';

const FAKE_PONG = 'PONG';

describe('health endpoints', () => {
  // The fakes stand in for the real connections and are switched per test.
  const up = { db: true, redis: true };
  const db = {
    execute: () => (up.db ? Promise.resolve([]) : Promise.reject(new Error('db down'))),
  };
  const redis = {
    ping: () => (up.redis ? Promise.resolve(FAKE_PONG) : Promise.reject(new Error('redis down'))),
    quit: () => Promise.resolve(),
  };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, RedisModule, HealthModule],
    })
      .overrideProvider(DB)
      .useValue(db)
      .overrideProvider(REDIS)
      .useValue(redis)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /health/live answers 200 with the health contract', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(HealthResponseSchema.parse(response.body)).toEqual({ status: HEALTH_STATUS.UP });
  });

  it('GET /health/ready answers 200 UP when Postgres and Redis answer', async () => {
    up.db = true;
    up.redis = true;

    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(HealthResponseSchema.parse(response.body)).toEqual({ status: HEALTH_STATUS.UP });
  });

  it('GET /health/ready answers 503 DOWN when Redis fails', async () => {
    up.db = true;
    up.redis = false;

    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(HealthResponseSchema.parse(response.body)).toEqual({ status: HEALTH_STATUS.DOWN });
  });

  it('GET /health/ready answers 503 DOWN when Postgres fails', async () => {
    up.db = false;
    up.redis = true;

    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(HealthResponseSchema.parse(response.body)).toEqual({ status: HEALTH_STATUS.DOWN });
  });
});
