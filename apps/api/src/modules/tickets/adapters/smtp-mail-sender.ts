import { createTransport } from 'nodemailer';

import type { MailSender } from '../domain/ticket.js';

/** Each phase of an SMTP exchange that stays silent this long fails: the queue delivers again. */
const SMTP_TIMEOUT_MS = 10_000;

/** Sends through the SMTP server of `smtpUrl` (Mailpit locally); every failure throws. */
export function createSmtpMailSender(
  smtpUrl: string,
  from: string,
  timeoutMs: number = SMTP_TIMEOUT_MS
): MailSender {
  const transport = createTransport({
    url: smtpUrl,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  return {
    async send({ to, subject, text, attachment }) {
      await transport.sendMail({
        from,
        to,
        subject,
        text,
        attachments: [{ filename: attachment.filename, content: Buffer.from(attachment.content) }],
      });
    },
  };
}
