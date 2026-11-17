import { Controller, Get, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { registerEsmHooks, startTestTracing } from './testing/index.js';

@Controller()
class ProbeController {
  @Get('ping')
  ping(): { ok: true } {
    return { ok: true };
  }

  @Get('health/live')
  health(): { ok: true } {
    return { ok: true };
  }

  @Get('metrics')
  metrics(): string {
    return '# metrics';
  }
}

describe('HTTP instrumentation ignoreIncomingRequestHook', () => {
  let tracing: ReturnType<typeof startTestTracing>;
  let app: INestApplication;

  beforeAll(async () => {
    registerEsmHooks();
    tracing = startTestTracing();
    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    tracing.exporter.reset();
  });

  afterAll(async () => {
    await app.close();
    await tracing.shutdown();
  });

  it('traces normal requests and ignores /health, /metrics and SSE streams', async () => {
    await request(app.getHttpServer()).get('/ping').expect(200);
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/metrics').expect(200);
    await request(app.getHttpServer()).get('/ping').set('Accept', 'text/event-stream').expect(200);

    const routes = tracing.exporter
      .getFinishedSpans()
      .map((span) => span.attributes['http.route'])
      .filter((route) => route !== undefined);
    expect(routes).toEqual(['/ping']);
  });
});
