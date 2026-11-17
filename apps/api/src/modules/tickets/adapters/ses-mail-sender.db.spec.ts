import { randomUUID } from 'node:crypto';

import { SES_IDENTITY } from '@app/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadEnv } from '../../../config/config.module.js';
import { createSesClient, createSesMailSender } from './ses-mail-sender.js';

const PDF = Buffer.from('%PDF-1.3 attached bytes', 'latin1');

const SesMessagesSchema = z.object({
  messages: z.array(
    z.object({
      Id: z.string(),
      Source: z.string(),
      RawData: z.string(),
    })
  ),
});

describe('SesMailSender against Floci SESv2', () => {
  const env = loadEnv();
  const client = createSesClient(env);

  afterAll(() => {
    client.destroy();
  });

  it('delivers the subject, the text and the PDF attachment from a verified identity', async () => {
    const to = `${randomUUID()}@example.test`;
    const sender = createSesMailSender(client, SES_IDENTITY.TICKETS_FROM);

    await sender.send({
      to,
      subject: 'Your ticket',
      text: 'See attached.',
      attachment: { filename: 'ticket.pdf', content: PDF },
    });

    const response = await fetch(`${env.AWS_ENDPOINT_URL}/_aws/ses`);
    expect(response.status).toBe(200);
    const { messages } = SesMessagesSchema.parse(await response.json());
    const matched = messages.filter((message) => {
      const raw = Buffer.from(message.RawData, 'base64').toString('utf8');
      return raw.includes(`To: ${to}`);
    });
    expect(matched).toHaveLength(1);
    const [first] = matched;
    if (first === undefined) throw new Error('Expected one matching SES message');
    const raw = Buffer.from(first.RawData, 'base64').toString('utf8');
    expect(first.Source).toBe(SES_IDENTITY.TICKETS_FROM);
    expect(raw).toContain('Subject: Your ticket');
    expect(raw).toContain('See attached.');
    expect(raw).toContain('filename=ticket.pdf');
    expect(raw).toContain(PDF.toString('base64'));
  });

  it('rejects with MessageRejected when the sender identity is not verified', async () => {
    const sender = createSesMailSender(client, `unverified-${randomUUID()}@example.test`);

    await expect(
      sender.send({
        to: 'a@example.test',
        subject: 's',
        text: 't',
        attachment: { filename: 'ticket.pdf', content: PDF },
      })
    ).rejects.toMatchObject({ name: 'MessageRejected' });
  });
});
