import type { MessageQueue, ReceivedMessage } from '../domain/message-queue.js';

type SendInput = { body: string; messageId: string };

/**
 * A queue that only records sends, for the specs of the relay. `behavior` runs on every send and
 * may delay or reject it; `attempted` lists the sends that started, `sent` those that were accepted.
 */
export class FakeMessageQueue implements MessageQueue {
  readonly attempted: SendInput[] = [];
  readonly sent: SendInput[] = [];

  constructor(
    private readonly behavior: (input: SendInput) => Promise<void> = () => Promise.resolve()
  ) {}

  async send(input: SendInput): Promise<void> {
    this.attempted.push(input);
    await this.behavior(input);
    this.sent.push(input);
  }

  receive(): Promise<ReceivedMessage[]> {
    throw new Error('FakeMessageQueue only records sends');
  }

  delete(): Promise<void> {
    throw new Error('FakeMessageQueue only records sends');
  }

  /** How often the message was accepted. */
  sentCount(messageId: string): number {
    return this.sent.filter((input) => input.messageId === messageId).length;
  }
}
