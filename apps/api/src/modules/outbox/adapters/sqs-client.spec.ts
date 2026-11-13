import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSqsClient } from './sqs-message-queue.js';

const TIMEOUT_MS = 300;
const CREDENTIALS = { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' };

describe('createSqsClient', () => {
  let hanging: Server;
  let endpoint: string;

  // Accepts the connection and never answers: a queue that has stopped responding.
  beforeAll(async () => {
    hanging = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`; // SAFETY: listening on a TCP port gives an AddressInfo
  });
  afterAll(async () => {
    hanging.closeAllConnections();
    await new Promise((resolve) => hanging.close(resolve));
  });

  it('a request to a queue that does not answer fails with a TimeoutError instead of hanging', async () => {
    const client = createSqsClient(
      { AWS_ENDPOINT_URL: endpoint, AWS_REGION: 'us-east-1', ...CREDENTIALS },
      TIMEOUT_MS
    );

    const started = Date.now();
    await expect(
      client.send(new SendMessageCommand({ QueueUrl: `${endpoint}/queue`, MessageBody: 'x' }))
    ).rejects.toMatchObject({ name: 'TimeoutError' });

    // One attempt: the relay and the consumer loop are the retry, a hung batch must stay short.
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 3);
    client.destroy();
  });
});
