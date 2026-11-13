import { QUEUE_POLICY } from '@app/shared';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';

import type { Env } from '../../../config/env.js';
import type { MessageQueue, ReceivedMessage } from '../domain/message-queue.js';

/** The message attribute that carries the outbox row ID. */
const MESSAGE_ID_ATTRIBUTE = 'messageId';
const RECEIVE_COUNT_ATTRIBUTE = 'ApproximateReceiveCount';

/** A send, a delete or a lookup that takes longer fails: the relay holds a transaction meanwhile. */
const SQS_REQUEST_TIMEOUT_MS = 5000;
const SQS_CONNECTION_TIMEOUT_MS = 3000;
/** A long poll is a request that waits on purpose; it gets its wait plus this much. */
const LONG_POLL_MARGIN_MS = 5000;

type AwsEnv = Pick<
  Env,
  'AWS_ENDPOINT_URL' | 'AWS_REGION' | 'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY'
>;

/** Endpoint and credentials come from the config module only; the SDK reads no environment itself. */
export function createSqsClient(
  env: AwsEnv,
  requestTimeoutMs: number = SQS_REQUEST_TIMEOUT_MS
): SQSClient {
  return new SQSClient({
    // One attempt: the relay and the consumer loop retry, so a down queue cannot hold a batch long.
    maxAttempts: 1,
    // Options of the node request handler (verified in @smithy/node-http-handler 4.x): without
    // `throwOnRequestTimeout` a breach of `requestTimeout` only logs a warning.
    requestHandler: {
      connectionTimeout: SQS_CONNECTION_TIMEOUT_MS,
      requestTimeout: requestTimeoutMs,
      throwOnRequestTimeout: true,
    },
    // Unset means real AWS.
    ...(env.AWS_ENDPOINT_URL === undefined ? {} : { endpoint: env.AWS_ENDPOINT_URL }),
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

const ReceivedSchema = z.object({
  Body: z.string(),
  ReceiptHandle: z.string(),
  MessageId: z.string(),
  Attributes: z.object({ [RECEIVE_COUNT_ATTRIBUTE]: z.coerce.number().int().positive() }),
  MessageAttributes: z
    .object({ [MESSAGE_ID_ATTRIBUTE]: z.object({ StringValue: z.string() }) })
    .partial()
    .optional(),
});

/** An SQS queue (the local emulator or AWS), addressed by its URL. */
export class SqsMessageQueue implements MessageQueue {
  private constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly waitSeconds: number
  ) {}

  /** Resolves the queue by name; fails fast when it does not exist, so a missing queue stops the start. */
  static async connect(
    client: SQSClient,
    queueName: string,
    waitSeconds: number = QUEUE_POLICY.LONG_POLL_SECONDS
  ): Promise<SqsMessageQueue> {
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (QueueUrl === undefined) throw new Error(`queue ${queueName} has no URL`);
    return new SqsMessageQueue(client, QueueUrl, waitSeconds);
  }

  async send(input: { body: string; messageId: string }): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: input.body,
        MessageAttributes: {
          [MESSAGE_ID_ATTRIBUTE]: { DataType: 'String', StringValue: input.messageId },
        },
      })
    );
  }

  async receive(max: number, signal?: AbortSignal): Promise<ReceivedMessage[]> {
    const { Messages = [] } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: this.waitSeconds,
        MessageAttributeNames: [MESSAGE_ID_ATTRIBUTE],
        MessageSystemAttributeNames: [RECEIVE_COUNT_ATTRIBUTE],
      }),
      {
        requestTimeout: this.waitSeconds * 1000 + LONG_POLL_MARGIN_MS,
        ...(signal === undefined ? {} : { abortSignal: signal }),
      }
    );
    return Messages.map((raw) => {
      const message = ReceivedSchema.parse(raw);
      return {
        body: message.Body,
        receiptHandle: message.ReceiptHandle,
        receiveCount: message.Attributes[RECEIVE_COUNT_ATTRIBUTE],
        // A message that did not come through the outbox has no attribute: the queue's own ID still names it in logs.
        messageId:
          message.MessageAttributes?.[MESSAGE_ID_ATTRIBUTE]?.StringValue ?? message.MessageId,
      };
    });
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle })
    );
  }
}
