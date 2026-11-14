import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';

import { metrics, trace } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SERVICE_NAME, startTelemetry } from './telemetry.js';

const SIGTERM = 'SIGTERM';
const LOOPBACK = '127.0.0.1';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, LOOPBACK, resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

const isTracing = (): boolean => trace.getTracer('probe').startSpan('probe').isRecording();
const isMetrics = (): boolean => metrics.getMeterProvider() instanceof MeterProvider;

describe('startTelemetry', () => {
  const signals = new EventEmitter();
  afterEach(async () => {
    signals.emit(SIGTERM);
    await vi.waitFor(() => expect(isTracing() || isMetrics()).toBe(false));
    signals.removeAllListeners();
  });

  async function start(flags: { tracing: boolean; metrics: boolean }): Promise<number> {
    const port = await freePort();
    await startTelemetry(
      {
        TRACING_ENABLED: flags.tracing,
        TRACING_OTLP_ENDPOINT: 'http://localhost:4318',
        METRICS_ENABLED: flags.metrics,
        METRICS_PORT: port,
        METRICS_HOST: LOOPBACK,
      },
      { serviceName: SERVICE_NAME.API, signals }
    );
    return port;
  }

  const scrape = (port: number): Promise<Response> => fetch(`http://${LOOPBACK}:${port}/metrics`);

  it('starts nothing and listens for no signal when both flags are off', async () => {
    await start({ tracing: false, metrics: false });

    expect(isTracing()).toBe(false);
    expect(isMetrics()).toBe(false);
    expect(signals.listenerCount(SIGTERM)).toBe(0);
  });

  it('starts only metrics when only metrics are on, and stops them on SIGTERM', async () => {
    const port = await start({ tracing: false, metrics: true });

    expect(isTracing()).toBe(false);
    expect((await vi.waitFor(() => scrape(port))).status).toBe(200);
    signals.emit(SIGTERM);
    await vi.waitFor(async () => expect(scrape(port)).rejects.toThrow());
    expect(isMetrics()).toBe(false);
  });

  it('starts only tracing when only tracing is on, and stops it on SIGTERM', async () => {
    const port = await start({ tracing: true, metrics: false });

    expect(isTracing()).toBe(true);
    expect(isMetrics()).toBe(false);
    await expect(scrape(port)).rejects.toThrow();
    signals.emit(SIGTERM);
    await vi.waitFor(() => expect(isTracing()).toBe(false));
  });

  it('starts both and stops both on one SIGTERM', async () => {
    const port = await start({ tracing: true, metrics: true });

    expect(isTracing()).toBe(true);
    expect((await vi.waitFor(() => scrape(port))).status).toBe(200);
    signals.emit(SIGTERM);
    await vi.waitFor(() => expect(isTracing()).toBe(false));
    await vi.waitFor(async () => expect(scrape(port)).rejects.toThrow());
    expect(isMetrics()).toBe(false);
  });
});
