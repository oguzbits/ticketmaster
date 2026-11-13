#!/usr/bin/env node

/**
 * Smoke test of the local AWS emulator (`docker compose up -d --wait aws`, see ADR 0004).
 * Proves the features the async chain relies on: redrive to a dead-letter queue after the max
 * receive count, visibility timeout, long polling, message attributes and a bucket round trip.
 * Uses its own throwaway resources, so it can run again at any time and leaves nothing behind.
 * Exits with status 1 on the first failed check.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { QUEUE_POLICY } from '../packages/shared/dist/index.js';

const config = {
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:45660',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};
const sqs = new SQSClient(config);
const s3 = new S3Client({ ...config, forcePathStyle: true });

const run = randomUUID().slice(0, 8);
const VISIBILITY_SECONDS = 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

async function check(name, body) {
  const started = Date.now();
  try {
    await body();
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
    throw error;
  }
  results.push(name);
  console.log(`ok   ${name} (${Date.now() - started} ms)`);
}

async function createQueue(name, attributes = {}) {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: `${name}-${run}`, Attributes: attributes })
  );
  return QueueUrl;
}

const count = async (url, attribute) => {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: [attribute] })
  );
  return Number(Attributes[attribute]);
};

const queues = [];
const bucket = `smoke-${run}`;

try {
  const dlq = await createQueue('smoke-dlq');
  const dlqArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))
  ).Attributes.QueueArn;
  const queue = await createQueue('smoke', {
    VisibilityTimeout: String(VISIBILITY_SECONDS),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: QUEUE_POLICY.MAX_RECEIVE_COUNT,
    }),
  });
  queues.push(queue, dlq);

  await check('create queue is idempotent for equal attributes', async () => {
    const again = await createQueue('smoke-dlq');
    assert.equal(again, dlq);
  });

  await check('message attributes round trip', async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: '{"hello":"world"}',
        MessageAttributes: { messageId: { DataType: 'String', StringValue: 'abc-123' } },
      })
    );
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue,
        MessageAttributeNames: ['All'],
        WaitTimeSeconds: 5,
      })
    );
    assert.equal(Messages?.length, 1);
    assert.equal(Messages[0].Body, '{"hello":"world"}');
    assert.equal(Messages[0].MessageAttributes.messageId.StringValue, 'abc-123');
  });

  await check('long polling returns early when a message arrives', async () => {
    const q = await createQueue('smoke-poll');
    queues.push(q);
    const started = Date.now();
    setTimeout(
      () => void sqs.send(new SendMessageCommand({ QueueUrl: q, MessageBody: 'late' })),
      1000
    );
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: q, WaitTimeSeconds: 10 })
    );
    const elapsed = Date.now() - started;
    assert.equal(Messages?.[0]?.Body, 'late');
    assert.ok(elapsed >= 900 && elapsed < 5000, `returned after ${elapsed} ms`);
  });

  await check('long polling waits on an empty queue', async () => {
    const q = await createQueue('smoke-empty');
    queues.push(q);
    const started = Date.now();
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: q, WaitTimeSeconds: 2 })
    );
    const elapsed = Date.now() - started;
    assert.equal(Messages, undefined);
    assert.ok(elapsed >= 1500, `returned after ${elapsed} ms, expected about 2000`);
  });

  await check('visibility timeout hides a message, then it returns', async () => {
    const q = await createQueue('smoke-visible', { VisibilityTimeout: String(VISIBILITY_SECONDS) });
    queues.push(q);
    await sqs.send(new SendMessageCommand({ QueueUrl: q, MessageBody: 'again' }));
    const first = await sqs.send(new ReceiveMessageCommand({ QueueUrl: q, WaitTimeSeconds: 2 }));
    assert.equal(first.Messages?.length, 1);
    const hidden = await sqs.send(new ReceiveMessageCommand({ QueueUrl: q, WaitTimeSeconds: 0 }));
    assert.equal(hidden.Messages, undefined);
    const second = await sqs.send(new ReceiveMessageCommand({ QueueUrl: q, WaitTimeSeconds: 5 }));
    assert.equal(second.Messages?.[0]?.Body, 'again');
  });

  await check(`redrive to the DLQ after ${QUEUE_POLICY.MAX_RECEIVE_COUNT} receives`, async () => {
    const poisoned = await createQueue('smoke-poison', {
      VisibilityTimeout: String(VISIBILITY_SECONDS),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: QUEUE_POLICY.MAX_RECEIVE_COUNT,
      }),
    });
    queues.push(poisoned);
    await sqs.send(new SendMessageCommand({ QueueUrl: poisoned, MessageBody: `poison-${run}` }));
    // Receive without deleting, like a handler that always throws.
    let received = 0;
    for (let i = 0; i < QUEUE_POLICY.MAX_RECEIVE_COUNT + 2; i += 1) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: poisoned, WaitTimeSeconds: 0 })
      );
      received += Messages?.length ?? 0;
      await sleep((VISIBILITY_SECONDS + 0.5) * 1000);
    }
    assert.equal(received, QUEUE_POLICY.MAX_RECEIVE_COUNT, 'handler must see it max times');
    assert.equal(await count(poisoned, 'ApproximateNumberOfMessages'), 0);
    assert.equal(await count(poisoned, 'ApproximateNumberOfMessagesNotVisible'), 0);
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 })
    );
    assert.ok(
      Messages?.some((m) => m.Body === `poison-${run}`),
      'message not in the DLQ'
    );
  });

  await check('bucket create, put and get', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: 'a/b.txt',
        Body: 'ticket',
        ContentType: 'text/plain',
      })
    );
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'a/b.txt' }));
    assert.equal(await object.Body.transformToString(), 'ticket');
    assert.equal(object.ContentType, 'text/plain');
  });
} finally {
  await Promise.allSettled([
    ...queues.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))),
    s3
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: 'a/b.txt' }))
      .then(() => s3.send(new DeleteBucketCommand({ Bucket: bucket }))),
  ]);
}
console.log(`${results.length} checks passed`);
