import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSesClient, createSesMailSender } from './ses-mail-sender.js';

const TIMEOUT_MS = 300;

describe('createSesMailSender', () => {
  let hanging: Server;
  let endpoint: string;

  // Accepts the connection and never answers: an SES endpoint that has stopped responding.
  beforeAll(async () => {
    hanging = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`; // SAFETY: listening on a TCP port gives an AddressInfo
  });
  afterAll(async () => {
    hanging.closeAllConnections();
    await new Promise((resolve) => hanging.close(resolve));
  });

  it('a silent SES endpoint fails with a TimeoutError instead of hanging', async () => {
    const client = createSesClient(
      {
        AWS_ENDPOINT_URL: endpoint,
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
      },
      TIMEOUT_MS
    );
    const sender = createSesMailSender(client, 'tickets@ticketmaster-klon.invalid');

    const started = Date.now();
    await expect(
      sender.send({
        to: 'a@example.test',
        subject: 'Your ticket',
        text: 'See attached.',
        attachment: { filename: 'ticket.pdf', content: Buffer.from('%PDF-') },
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' });

    // One attempt: the queue redelivers, so a hung effect must end within its timeout.
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 3);
    client.destroy();
  });
});
