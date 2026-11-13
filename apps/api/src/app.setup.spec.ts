import { Controller, Get, type INestApplication, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureApp } from './app.setup.js';
import { APP_CONFIG, ConfigModule, loadEnv } from './config/config.module.js';
import { DatabaseModule, DB } from './infrastructure/database/database.module.js';
import { REDIS, RedisModule } from './infrastructure/redis/redis.module.js';
import { HealthModule } from './modules/health/index.js';

@Controller('ping')
class PingController {
  @Get()
  ping(): { pong: true } {
    return { pong: true };
  }

  @Get('ip')
  ip(@Req() req: { ip?: string }): { ip: string | undefined } {
    return { ip: req.ip };
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret detail from inside');
  }
}

const ALLOWED_ORIGIN = 'http://localhost:4200';
const OTHER_ORIGIN = 'http://localhost:4201';

async function createApp(corsOrigin?: string): Promise<INestApplication> {
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
    .overrideProvider(APP_CONFIG)
    .useValue({ ...loadEnv(), CORS_ORIGIN: corsOrigin })
    .overrideProvider(DB)
    .useValue({ execute: () => Promise.resolve([]) })
    .overrideProvider(REDIS)
    .useValue({ ping: () => Promise.resolve('PONG'), quit: () => Promise.resolve() })
    .compile();
  const app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
  await app.init();
  return app;
}

describe('configureApp', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
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

  it('sets security headers and does not announce the framework', async () => {
    const { headers } = await request(app.getHttpServer()).get('/api/ping').expect(200);

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-powered-by']).toBeUndefined();
  });

  it('takes the client address from the last proxy hop, not from a forged prefix', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/ping/ip')
      .set('X-Forwarded-For', '1.2.3.4, 9.9.9.9')
      .expect(200);

    expect(response.body).toEqual({ ip: '9.9.9.9' });
  });

  it('answers a non-HTTP error with 500 and no message or stack', async () => {
    const response = await request(app.getHttpServer()).get('/api/ping/boom').expect(500);

    expect(JSON.stringify(response.body)).not.toContain('secret detail');
    expect(JSON.stringify(response.body)).not.toContain('at ');
  });

  it('sends no CORS headers when no origin is configured', async () => {
    const { headers } = await request(app.getHttpServer())
      .get('/api/ping')
      .set('Origin', ALLOWED_ORIGIN);

    expect(headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('configureApp with CORS_ORIGIN', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // A trailing slash in the setting must not stop the browser's origin from matching.
    app = await createApp(`${ALLOWED_ORIGIN}/`);
  });

  afterAll(() => app.close());

  it('allows the configured origin, without credentials', async () => {
    const { headers } = await request(app.getHttpServer())
      .get('/api/ping')
      .set('Origin', ALLOWED_ORIGIN);

    expect(headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers the preflight of the configured origin with the allowed headers', async () => {
    const { headers } = await request(app.getHttpServer())
      .options('/api/ping')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);

    expect(headers['access-control-allow-headers']).toBe('Authorization,Content-Type');
  });

  it('gives any other origin no CORS header', async () => {
    const { headers } = await request(app.getHttpServer())
      .get('/api/ping')
      .set('Origin', OTHER_ORIGIN);

    expect(headers['access-control-allow-origin']).toBeUndefined();
  });
});
