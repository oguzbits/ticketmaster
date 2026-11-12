import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { configureApp } from './app.setup.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule, DB } from './infrastructure/database/database.module.js';
import { REDIS, RedisModule } from './infrastructure/redis/redis.module.js';
import { HealthModule } from './modules/health/index.js';

@Controller('ping')
class PingController {
  @Get()
  ping(): { pong: true } {
    return { pong: true };
  }
}

describe('configureApp', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ConfigModule,
        DatabaseModule,
        RedisModule,
        HealthModule,
      ],
      controllers: [PingController],
    })
      .overrideProvider(DB)
      .useValue({ execute: () => Promise.resolve([]) })
      .overrideProvider(REDIS)
      .useValue({ ping: () => Promise.resolve('PONG'), quit: () => Promise.resolve() })
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(() => app.close());

  it('serves a route under /api and not at the root', async () => {
    await request(app.getHttpServer()).get('/api/ping').expect(200);
    await request(app.getHttpServer()).get('/ping').expect(404);
  });

  it('keeps the health routes unprefixed', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
    await request(app.getHttpServer()).get('/api/health/live').expect(404);
  });
});
