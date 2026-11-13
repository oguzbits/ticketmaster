import { randomUUID } from 'node:crypto';

import type { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../../config/config.module.js';
import { createScratchQueue } from '../testing/scratch-queue.js';
import { createSqsClient, SqsMessageQueue } from './sqs-message-queue.js';

// A queue of its own for this file, so no other spec file sees or takes its messages. Messages
// reappear after the visibility timeout; the poll time is a little longer than that.
const VISIBILITY_SECONDS = 1;
const POLL_SECONDS = 2;

describe('SqsMessageQueue against the local emulator', () => {
  let client: SQSClient;
  let queue: SqsMessageQueue;
  let destroy: () => Promise<void>;

  beforeAll(async () => {
    client = createSqsClient(loadEnv());
    const scratch = await createScratchQueue(client, VISIBILITY_SECONDS);
    destroy = scratch.destroy;
    queue = await SqsMessageQueue.connect(client, scratch.queueName, POLL_SECONDS);
  });
  afterAll(async () => {
    await destroy();
    client.destroy();
  });

  it('fails fast when the queue does not exist', async () => {
    await expect(SqsMessageQueue.connect(client, `missing-${randomUUID()}`)).rejects.toMatchObject({
      name: 'QueueDoesNotExist',
    });
  });

  it('delivers a sent message with its body and message ID and receive count 1', async () => {
    const messageId = randomUUID();
    await queue.send({ body: `{"id":"${messageId}"}`, messageId });

    const [received, ...rest] = await queue.receive(10);

    expect(rest).toEqual([]);
    expect(received).toMatchObject({
      body: `{"id":"${messageId}"}`,
      messageId,
      receiveCount: 1,
    });
    if (received === undefined) throw new Error('nothing received');
    await queue.delete(received.receiptHandle);
  });

  it('a message that is not deleted comes back with a higher receive count', async () => {
    const messageId = randomUUID();
    await queue.send({ body: 'again', messageId });
    const [first] = await queue.receive(1);

    const [second] = await queue.receive(1);

    expect(first).toMatchObject({ messageId, receiveCount: 1 });
    expect(second).toMatchObject({ messageId, receiveCount: 2 });
    if (second === undefined) throw new Error('nothing received');
    await queue.delete(second.receiptHandle);
  });

  it('a deleted message does not come back', async () => {
    await queue.send({ body: 'gone', messageId: randomUUID() });
    const [received] = await queue.receive(1);
    if (received === undefined) throw new Error('nothing received');

    await queue.delete(received.receiptHandle);

    // Longer than the visibility timeout: an undeleted message would be back by now.
    expect(await queue.receive(1)).toEqual([]);
  });
});
