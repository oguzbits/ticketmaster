import { Controller, type INestApplication, Post } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestTracing } from '../tracing/testing/index.js';
import { HTTP_ATTR, METRIC } from './names.js';
import {
  dataPoints,
  observationCount,
  registerEsmHooks,
  startTestMetrics,
} from './testing/index.js';

@Controller('ping')
class PingController {
  @Post()
  ping(): { ok: true } {
    return { ok: true };
  }
}

describe('metrics and tracing started together', () => {
  let tracing: ReturnType<typeof startTestTracing>;
  let metrics: ReturnType<typeof startTestMetrics>;
  let app: INestApplication;
  beforeAll(async () => {
    registerEsmHooks();
    tracing = startTestTracing();
    metrics = startTestMetrics();
    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await metrics.shutdown();
  });

  it('registers the HTTP instrumentation once: a request is one data point and one span', async () => {
    await request(app.getHttpServer()).post('/ping').expect(201);

    const points = dataPoints(await metrics.collect(), METRIC.HTTP_SERVER_DURATION).filter(
      (point) => point.attributes[HTTP_ATTR.ROUTE] === '/ping'
    );
    expect(points.map(observationCount)).toEqual([1]);
    const serverSpans = tracing.exporter
      .getFinishedSpans()
      .filter((span) => span.attributes[HTTP_ATTR.ROUTE] === '/ping');
    expect(serverSpans).toHaveLength(1);
  });

  it('keeps recording after tracing shut down: the last release unregisters', async () => {
    await tracing.shutdown();
    await request(app.getHttpServer()).post('/ping').expect(201);

    const points = dataPoints(await metrics.collect(), METRIC.HTTP_SERVER_DURATION).filter(
      (point) => point.attributes[HTTP_ATTR.ROUTE] === '/ping'
    );
    expect(points.map(observationCount)).toEqual([2]);
  });
});
