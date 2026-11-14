import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createS3Client, S3TicketStore } from './s3-ticket-store.js';

const TIMEOUT_MS = 300;

describe('createS3Client', () => {
  let hanging: Server;
  let endpoint: string;

  // Accepts the connection and never answers: a bucket that has stopped responding.
  beforeAll(async () => {
    hanging = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`; // SAFETY: listening on a TCP port gives an AddressInfo
  });
  afterAll(async () => {
    hanging.closeAllConnections();
    await new Promise((resolve) => hanging.close(resolve));
  });

  it('a request to a bucket that does not answer fails with a TimeoutError instead of hanging', async () => {
    const client = createS3Client(
      {
        AWS_ENDPOINT_URL: endpoint,
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
      },
      TIMEOUT_MS
    );

    const started = Date.now();
    await expect(
      new S3TicketStore(client, 'tickets').put('booking', Buffer.from('x'))
    ).rejects.toMatchObject({ name: 'TimeoutError' });

    // One attempt: the queue redelivers, so a hung effect must end within its timeout.
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 3);
    client.destroy();
  });
});
