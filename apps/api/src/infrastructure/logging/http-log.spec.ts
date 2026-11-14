import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { pinoHttp } from 'pino-http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SPAN_NAME, withSpan } from '../tracing/index.js';
import { startTestTracing } from '../tracing/testing/index.js';
import { httpLogOptions } from './http-log.js';

const LogLineSchema = z.object({ req: z.object({}).loose(), res: z.object({}).loose() });

const REQUEST_ID = 'trace-42';
const CLIENT_IP = '203.0.113.9';
const TOKEN = 'secret-token';

describe('http request log', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise((resolve) => server?.close(resolve)));

  async function loggedLine(): Promise<{ raw: string; parsed: z.infer<typeof LogLineSchema> }> {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pinoHttp({ ...httpLogOptions }, stream);
    server = http.createServer((req, res) => {
      logger(req, res);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo; // SAFETY: listening on a TCP port
    await fetch(`http://127.0.0.1:${port}/events?q=1`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        cookie: `session=${TOKEN}`,
        'x-forwarded-for': CLIENT_IP,
        'x-request-id': REQUEST_ID,
      },
    });
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    const raw = lines[0] ?? '';
    return { raw, parsed: LogLineSchema.parse(JSON.parse(raw)) };
  }

  it('logs only id, method and url of the request and the status of the response', async () => {
    const { parsed } = await loggedLine();

    expect(parsed.req).toEqual({ id: REQUEST_ID, method: 'GET', url: '/events?q=1' });
    expect(parsed.res).toEqual({ statusCode: 200 });
  });

  it('never writes headers or the client address', async () => {
    const { raw } = await loggedLine();

    for (const secret of [TOKEN, CLIENT_IP, '127.0.0.1', 'authorization', 'cookie', 'remote']) {
      expect(raw.toLowerCase()).not.toContain(secret);
    }
  });

  describe('trace correlation', () => {
    const TRACE_ID = /^[0-9a-f]{32}$/;
    const TraceFieldsSchema = z.object({
      trace_id: z.string().optional(),
      span_id: z.string().optional(),
    });

    async function lineLoggedIn(inSpan: boolean): Promise<z.infer<typeof TraceFieldsSchema>> {
      const lines: string[] = [];
      const stream = new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString());
          done();
        },
      });
      const { logger } = pinoHttp({ ...httpLogOptions }, stream);
      if (inSpan) {
        await withSpan(SPAN_NAME.OUTBOX_SEND, () => {
          logger.info('inside');
          return Promise.resolve();
        });
      } else {
        logger.info('inside');
      }
      return TraceFieldsSchema.parse(JSON.parse(lines[0] ?? ''));
    }

    it('writes the trace ID of the active span', async () => {
      const tracing = startTestTracing();
      try {
        const line = await lineLoggedIn(true);

        expect(line.trace_id).toMatch(TRACE_ID);
        expect(line.span_id).toBeDefined();
      } finally {
        await tracing.shutdown();
      }
    });

    it('writes no trace keys outside a span', async () => {
      const line = await lineLoggedIn(false);

      expect(line).not.toHaveProperty('trace_id');
      expect(line).not.toHaveProperty('span_id');
    });
  });
});
