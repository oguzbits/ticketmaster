import { randomUUID } from 'node:crypto';

import { QUEUE_NAME } from '@app/shared';
import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../../config/config.module.js';
import { currentTraceparent, withSpan } from '../../../infrastructure/tracing/index.js';
import { startTestTracing } from '../../../infrastructure/tracing/testing/index.js';
import { createScratchQueue } from '../testing/scratch-queue.js';
import { createSqsClient, SqsMessageQueue } from './sqs-message-queue.js';

// A queue of its own for this file, so no other spec file sees or takes its messages. Messages
// reappear after the visibility timeout; the poll time is a little longer than that.
const VISIBILITY_SECONDS = 1;
const POLL_SECONDS = 2;
const SHORT_TIMEOUT_MS = 500;
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('SqsMessageQueue against the local emulator', () => {
  let client: SQSClient;
  let queue: SqsMessageQueue;
  let queueName: string;
  let destroy: () => Promise<void>;
  let queueUrl: string;

  beforeAll(async () => {
    client = createSqsClient(loadEnv());
    const scratch = await createScratchQueue(client, VISIBILITY_SECONDS);
    destroy = scratch.destroy;
    queueName = scratch.queueName;
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (QueueUrl === undefined) throw new Error('scratch queue has no URL');
    queueUrl = QueueUrl;
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
    await queue.send({ body: `{"id":"${messageId}"}`, messageId, traceparent: null });

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

  it('carries the traceparent in a message attribute and hands it back on receive', async () => {
    const messageId = randomUUID();
    await queue.send({ body: 'traced', messageId, traceparent: TRACEPARENT });

    const [received] = await queue.receive(1);

    expect(received).toMatchObject({ messageId, traceparent: TRACEPARENT });
    if (received === undefined) throw new Error('nothing received');
    await queue.delete(received.receiptHandle);
  });

  it('a send inside a traced span reaches the consumer side in the same trace', async () => {
    // The AWS instrumentation overwrites an explicit attribute (same trace ID, new span ID), so the
    // trace ID is the contract, not the whole value.
    const { shutdown } = startTestTracing();
    try {
      const messageId = randomUUID();
      const sentFrom = await withSpan('probe', async () => {
        const traceparent = currentTraceparent();
        await queue.send({ body: 'traced', messageId, traceparent });
        return traceparent;
      });

      const [received] = await queue.receive(1);

      expect(received?.traceparent?.split('-')[1]).toBe(sentFrom?.split('-')[1]);
      if (received === undefined) throw new Error('nothing received');
      await queue.delete(received.receiptHandle);
    } finally {
      await shutdown();
    }
  });

  it.each([
    ['no attribute', undefined],
    ['a malformed attribute', 'garbage'],
  ])('a message with %s comes back with a null traceparent', async (_name, attribute) => {
    const messageId = randomUUID();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: 'old',
        MessageAttributes: {
          messageId: { DataType: 'String', StringValue: messageId },
          ...(attribute === undefined
            ? {}
            : { traceparent: { DataType: 'String', StringValue: attribute } }),
        },
      })
    );

    const [received] = await queue.receive(1);

    expect(received).toMatchObject({ messageId, traceparent: null });
    if (received === undefined) throw new Error('nothing received');
    await queue.delete(received.receiptHandle);
  });

  it('a message that is not deleted comes back with a higher receive count', async () => {
    const messageId = randomUUID();
    await queue.send({ body: 'again', messageId, traceparent: null });
    const [first] = await queue.receive(1);

    const [second] = await queue.receive(1);

    expect(first).toMatchObject({ messageId, receiveCount: 1 });
    expect(second).toMatchObject({ messageId, receiveCount: 2 });
    if (second === undefined) throw new Error('nothing received');
    await queue.delete(second.receiptHandle);
  });

  it('a long poll may outlast the default request timeout', async () => {
    const impatient = createSqsClient(loadEnv(), SHORT_TIMEOUT_MS);
    const waiting = await SqsMessageQueue.connect(impatient, queueName, POLL_SECONDS);

    // The poll waits POLL_SECONDS on the empty queue, longer than the client's default timeout.
    expect(await waiting.receive(1)).toEqual([]);
    impatient.destroy();
  });

  it('a deleted message does not come back', async () => {
    await queue.send({ body: 'gone', messageId: randomUUID(), traceparent: null });
    const [received] = await queue.receive(1);
    if (received === undefined) throw new Error('nothing received');

    await queue.delete(received.receiptHandle);

    // Longer than the visibility timeout: an undeleted message would be back by now.
    expect(await queue.receive(1)).toEqual([]);
  });

  it('depth counts the visible messages of the named queue, the dead-letter queue included', async () => {
    // The production queues: other specs use scratch queues, so only this test touches the DLQ.
    const dlq = await SqsMessageQueue.connect(client, QUEUE_NAME.BOOKING_EVENTS_DLQ, POLL_SECONDS);
    const before = await queue.depth(QUEUE_NAME.BOOKING_EVENTS_DLQ);
    const sent: string[] = [randomUUID(), randomUUID(), randomUUID()];
    for (const messageId of sent) await dlq.send({ body: 'dead', messageId, traceparent: null });

    expect(await queue.depth(QUEUE_NAME.BOOKING_EVENTS_DLQ)).toBe(before + sent.length);

    // Take only the messages of this test off the queue again.
    for (const received of await dlq.receive(10)) {
      if (sent.includes(received.messageId)) await dlq.delete(received.receiptHandle);
    }
  });
});
