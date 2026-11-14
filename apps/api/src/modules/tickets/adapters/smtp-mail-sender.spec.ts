import { createServer, type Server } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSmtpMailSender } from './smtp-mail-sender.js';

const TIMEOUT_MS = 300;

describe('createSmtpMailSender', () => {
  let silent: Server;
  let port: number;

  // Accepts the connection and never greets: a mail server that has stopped responding.
  beforeAll(async () => {
    silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = silent.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP port');
    port = address.port;
  });
  afterAll(async () => {
    await new Promise((resolve) => silent.close(resolve));
  });

  it('a mail server that accepts but never greets fails within the timeout instead of hanging', async () => {
    const sender = createSmtpMailSender(
      `smtp://127.0.0.1:${port}`,
      'tickets@ticketmaster-klon.invalid',
      TIMEOUT_MS
    );

    const started = Date.now();
    await expect(
      sender.send({
        to: 'a@example.test',
        subject: 's',
        text: 't',
        attachment: { filename: 'ticket.pdf', content: Buffer.from('%PDF-') },
      })
    ).rejects.toThrow();

    // One attempt: the queue redelivers, so a hung effect must end within its timeout.
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 5);
  }, 15_000);
});
