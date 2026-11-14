import { Writable } from 'node:stream';

import { SPAN_NAME, withSpan } from '@app/api/tracing';
import { startTestTracing } from '@app/api/tracing/testing';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule } from 'nestjs-pino';
import { afterEach, describe, expect, it } from 'vitest';

import { workerLogOptions } from './worker-logger.js';

describe('worker logger', () => {
  let shutdown: (() => Promise<void>) | undefined;
  afterEach(() => shutdown?.());

  it('writes the trace ID of the active span on a log line', async () => {
    shutdown = startTestTracing().shutdown;
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: [workerLogOptions, stream] })],
    }).compile();
    const logger = module.get(Logger);

    await withSpan(SPAN_NAME.QUEUE_PROCESS, () => {
      logger.log('processing');
      return Promise.resolve();
    });

    expect(lines[0]).toMatch(/"trace_id":"[0-9a-f]{32}"/);
  });
});
