import { Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SERVICE_NAME } from '../tracing/index.js';
import { failOnBindError, startMetrics } from './metrics.js';
import { HTTP_ATTR, METRIC, ROUTE_UNMATCHED } from './names.js';
import {
  dataPoints,
  observationCount,
  registerEsmHooks,
  startTestMetrics,
} from './testing/index.js';

const UUID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

@Controller('bookings')
class PaymentController {
  @Post(':id/payment')
  pay(): { ok: true } {
    return { ok: true };
  }

  @Get()
  list(): never[] {
    return [];
  }
}

describe('failOnBindError', () => {
  it('rethrows the error of a listener that could not bind, and ignores success', () => {
    expect(() => failOnBindError(undefined)).not.toThrow();
    expect(() => failOnBindError(new Error('EADDRINUSE'))).toThrow('EADDRINUSE');
  });
});

describe('startMetrics', () => {
  it('returns null and leaves the global meter provider alone when metrics are off', () => {
    const handle = startMetrics(
      { METRICS_ENABLED: false, METRICS_PORT: 9464, METRICS_HOST: '127.0.0.1' },
      { serviceName: SERVICE_NAME.API }
    );

    expect(handle).toBeNull();
    expect(metrics.getMeterProvider()).not.toBeInstanceOf(MeterProvider);
  });
});

describe('RED histogram', () => {
  // One start per file: Express is patched when it is first required, which happens once per worker.
  let started: ReturnType<typeof startTestMetrics>;
  let app: INestApplication;
  beforeAll(async () => {
    registerEsmHooks();
    started = startTestMetrics();
    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await started.shutdown();
  });

  it('labels a request with the route template and counts it once', async () => {
    await request(app.getHttpServer()).post(`/api/bookings/${UUID}/payment`).expect(201);

    const points = dataPoints(await started.collect(), METRIC.HTTP_SERVER_DURATION).filter(
      (point) => point.attributes[HTTP_ATTR.ROUTE] === '/api/bookings/:id/payment'
    );
    expect(points.map(observationCount)).toEqual([1]);
    expect(points[0]?.attributes[HTTP_ATTR.METHOD]).toBe('POST');
    expect(points[0]?.attributes[HTTP_ATTR.STATUS]).toBe(201);
    // The instrumentation also writes url.scheme and network.protocol.version: the view drops them.
    expect(Object.keys(points[0]?.attributes ?? {}).sort()).toEqual(
      [HTTP_ATTR.METHOD, HTTP_ATTR.ROUTE, HTTP_ATTR.STATUS].sort()
    );
  });

  it('collapses a request no route matched into UNMATCHED, with no URL in any label', async () => {
    await request(app.getHttpServer()).get(`/nope/${UUID}`).expect(404);

    const points = dataPoints(await started.collect(), METRIC.HTTP_SERVER_DURATION);
    const unmatched = points.filter(
      (point) => point.attributes[HTTP_ATTR.ROUTE] === ROUTE_UNMATCHED
    );
    expect(unmatched.map(observationCount)).toEqual([1]);
    const values = points.flatMap((point) => Object.values(point.attributes).map(String));
    expect(values.filter((value) => value.includes(UUID))).toEqual([]);
  });
});
