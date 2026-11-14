import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { mailsTo } from '../testing/mailpit.js';
import { createSmtpMailSender } from './smtp-mail-sender.js';

const SMTP_URL = 'smtp://localhost:1025';
const FROM = 'tickets@ticketmaster-klon.invalid';
const PDF = Buffer.from('%PDF-1.3 attached bytes', 'latin1');

describe('SmtpMailSender against Mailpit', () => {
  it('delivers the subject, the text and the attachment unchanged', async () => {
    const to = `${randomUUID()}@example.test`;
    const sender = createSmtpMailSender(SMTP_URL, FROM);

    await sender.send({
      to,
      subject: 'Your ticket',
      text: 'See attached.',
      attachment: { filename: 'ticket.pdf', content: PDF },
    });

    const [mail, ...others] = await mailsTo(to);
    expect(others).toEqual([]);
    expect(mail?.subject).toBe('Your ticket');
    expect(mail?.text).toContain('See attached.');
    expect(mail?.attachments).toEqual([{ filename: 'ticket.pdf', content: PDF }]);
  });

  it('rejects when the mail server cannot be reached, instead of dropping the mail', async () => {
    const sender = createSmtpMailSender('smtp://127.0.0.1:1', FROM);

    await expect(
      sender.send({
        to: 'a@example.test',
        subject: 's',
        text: 't',
        attachment: { filename: 'ticket.pdf', content: PDF },
      })
    ).rejects.toMatchObject({ code: 'ESOCKET' });
  });
});
