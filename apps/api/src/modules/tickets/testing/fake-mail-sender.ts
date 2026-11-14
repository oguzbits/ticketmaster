import type { MailSender } from '../domain/ticket.js';

type Mail = Parameters<MailSender['send']>[0];

/** A mail sender that records what it sent; `failures` says how many sends still fail. */
export class FakeMailSender implements MailSender {
  readonly sent: Mail[] = [];
  failures = 0;

  send(mail: Mail): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('mail server is down'));
    }
    this.sent.push(mail);
    return Promise.resolve();
  }
}
