import { HEALTH_STATUS, HealthResponseSchema } from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HealthModule } from './health.module.js';

describe('GET /health/live', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('answers 200 with the health contract', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(HealthResponseSchema.parse(response.body)).toEqual({ status: HEALTH_STATUS.UP });
  });
});
