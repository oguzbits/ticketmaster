import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { createTransport } from 'nodemailer';

import type { Env } from '../../../config/env.js';
import type { MailSender } from '../domain/ticket.js';

/** Each SES request that stays silent this long fails: the queue delivers again. */
const SES_REQUEST_TIMEOUT_MS = 10_000;
const SES_CONNECTION_TIMEOUT_MS = 3000;

type AwsEnv = Pick<
  Env,
  'AWS_ENDPOINT_URL' | 'AWS_REGION' | 'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY'
>;

/** Endpoint and credentials come from the config module only; the SDK reads no environment itself. */
export function createSesClient(
  env: AwsEnv,
  requestTimeoutMs: number = SES_REQUEST_TIMEOUT_MS
): SESv2Client {
  return new SESv2Client({
    // One attempt: the queue is the retry, so a hung endpoint cannot hold a handler past its timeout.
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: SES_CONNECTION_TIMEOUT_MS,
      requestTimeout: requestTimeoutMs,
      throwOnRequestTimeout: true,
    },
    ...(env.AWS_ENDPOINT_URL === undefined ? {} : { endpoint: env.AWS_ENDPOINT_URL }),
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

/** Sends ticket confirmations as raw MIME messages via AWS SESv2 (real AWS or the emulator). */
export function createSesMailSender(client: SESv2Client, from: string): MailSender {
  const composer = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  return {
    async send({ to, subject, text, attachment }) {
      const info = await composer.sendMail({
        from,
        to,
        subject,
        text,
        attachments: [{ filename: attachment.filename, content: Buffer.from(attachment.content) }],
      });
      if (!(info.message instanceof Uint8Array)) {
        throw new Error('Expected buffered MIME message');
      }
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [to] },
          Content: { Raw: { Data: info.message } },
        })
      );
    },
  };
}
