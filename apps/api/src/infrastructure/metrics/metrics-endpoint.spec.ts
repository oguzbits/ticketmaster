import { createServer as createNetServer } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { SERVICE_NAME } from '../tracing/index.js';
import { startMetrics } from './metrics.js';
import { registerEsmHooks } from './testing/index.js';

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('Prometheus endpoint', () => {
  it('serves /metrics on METRICS_PORT and closes the port on shutdown', async () => {
    const port = await freePort();
    registerEsmHooks();
    const handle = startMetrics(
      { METRICS_ENABLED: true, METRICS_PORT: port, METRICS_HOST: '127.0.0.1' },
      { serviceName: SERVICE_NAME.API }
    );
    // Created after the start: the HTTP server is patched when `node:http` is first required.
    const { createServer } = await import('node:http');
    const app = createServer((_request, response) => response.end('ok')).listen(0, '127.0.0.1');
    await new Promise((resolve) => app.once('listening', resolve));
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    await fetch(`http://127.0.0.1:${address.port}/anything`);
    app.close();
    const url = `http://127.0.0.1:${port}/metrics`;

    // The listener comes up asynchronously.
    const response = await vi.waitFor(async () => fetch(url), { timeout: 2000 });
    await response.text();
    const body = await (await fetch(url)).text();
    expect(response.status).toBe(200);
    expect(body).toContain('http_server_request_duration_bucket');
    // Two scrapes ran through the patched server; only the request to the app is counted.
    const counts = [...body.matchAll(/^http_server_request_duration_count\{.*\} (\d+)$/gm)];
    expect(counts.map((match) => match[1])).toEqual(['1']);

    await handle?.shutdown();
    await expect(fetch(url)).rejects.toThrow();
  });
});
