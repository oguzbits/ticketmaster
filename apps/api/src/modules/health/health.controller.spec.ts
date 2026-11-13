import { HEALTH_STATUS, HealthResponseSchema, OUTBOX_SIGNAL } from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigModule } from '../../config/config.module.js';
import { DatabaseModule, DB } from '../../infrastructure/database/database.module.js';
import { REDIS, RedisModule } from '../../infrastructure/redis/redis.module.js';
import { MESSAGE_QUEUE, OUTBOX_STUCK_SECONDS, OutboxService } from '../outbox/index.js';
import { FakeMessageQueue } from '../outbox/testing/index.js';
import { HealthModule } from './health.module.js';

const FAKE_PONG = 'PONG';

describe('health endpoints', () => {
  // The fakes stand in for the real connections and are switched per test.
  const up = { db: true, redis: true };
  // Age of the oldest unpublished outbox row; null when there is none.
  const outbox: { ageSeconds: number | null; failing: boolean } = {
    ageSeconds: null,
    failing: false,
  };
  const db = {
    execute: () => (up.db ? Promise.resolve([]) : Promise.reject(new Error('db down'))),
  };
  const redis = {
    ping: () => (up.redis ? Promise.resolve(FAKE_PONG) : Promise.reject(new Error('redis down'))),
    quit: () => Promise.resolve(),
  };
  const outboxService = {
    oldestUnpublishedAgeSeconds: () =>
      outbox.failing ? Promise.reject(new Error('db down')) : Promise.resolve(outbox.ageSeconds),
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
      .overrideProvider(MESSAGE_QUEUE)
      .useValue(new FakeMessageQueue())
      .overrideProvider(OutboxService)
      .useValue(outboxService)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /health/live answers 200 with the health contract', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(HealthResponseSchema.parse(response.body)).toEqual({ status: HEALTH_STATUS.UP });
  });

  beforeEach(() => {
    up.db = true;
    up.redis = true;
    outbox.ageSeconds = null;
    outbox.failing = false;
  });

  it('GET /health/ready answers 200 UP with the outbox signal ok when nothing waits', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(HealthResponseSchema.parse(response.body)).toEqual({
      status: HEALTH_STATUS.UP,
      signals: { outbox: OUTBOX_SIGNAL.OK },
    });
  });

  it('GET /health/ready keeps the outbox signal ok up to the stuck limit', async () => {
    outbox.ageSeconds = OUTBOX_STUCK_SECONDS;

    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(HealthResponseSchema.parse(response.body).signals).toEqual({ outbox: OUTBOX_SIGNAL.OK });
  });

  it('GET /health/ready reports the outbox as stuck past the limit and still answers 200 UP', async () => {
    outbox.ageSeconds = OUTBOX_STUCK_SECONDS + 1;

    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(HealthResponseSchema.parse(response.body)).toEqual({
      status: HEALTH_STATUS.UP,
      signals: { outbox: OUTBOX_SIGNAL.STUCK },
    });
  });

  it('GET /health/ready answers 503 DOWN when the outbox cannot be read', async () => {
    outbox.failing = true;

    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(HealthResponseSchema.parse(response.body)).toEqual({ status: HEALTH_STATUS.DOWN });
  });

  it('GET /health/ready answers 503 DOWN when Redis fails', async () => {
    up.redis = false;

    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(HealthResponseSchema.parse(response.body)).toEqual({ status: HEALTH_STATUS.DOWN });
  });

  it('GET /health/ready answers 503 DOWN when Postgres fails', async () => {
    up.db = false;

    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(HealthResponseSchema.parse(response.body)).toEqual({ status: HEALTH_STATUS.DOWN });
  });
});
