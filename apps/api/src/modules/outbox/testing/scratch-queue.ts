import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

/**
 * A queue of its own with a random name, so a spec never shares messages with another spec file
 * (the db specs run side by side against one emulator). `destroy` removes it.
 */
export async function createScratchQueue(
  client: SQSClient,
  visibilityTimeoutSeconds: number
): Promise<{ queueName: string; destroy: () => Promise<void> }> {
  const { queueName, destroy } = await createQueue(client, {
    VisibilityTimeout: String(visibilityTimeoutSeconds),
  });
  return { queueName, destroy };
}

/**
 * A scratch queue with a dead-letter queue of its own: a message received `maxReceiveCount` times
 * without being deleted moves there, as in production.
 */
export async function createScratchQueueWithDlq(
  client: SQSClient,
  visibilityTimeoutSeconds: number,
  maxReceiveCount: number
): Promise<{ queueName: string; dlqName: string; destroy: () => Promise<void> }> {
  const dlq = await createQueue(client, {});
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.queueUrl, AttributeNames: ['QueueArn'] })
  );
  const main = await createQueue(client, {
    VisibilityTimeout: String(visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: Attributes?.QueueArn,
      maxReceiveCount,
    }),
  });
  return {
    queueName: main.queueName,
    dlqName: dlq.queueName,
    destroy: async () => {
      await main.destroy();
      await dlq.destroy();
    },
  };
}

async function createQueue(
  client: SQSClient,
  attributes: Record<string, string>
): Promise<{ queueName: string; queueUrl: string | undefined; destroy: () => Promise<void> }> {
  const queueName = `spec-${randomUUID()}`;
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: queueName, Attributes: attributes })
  );
  return {
    queueName,
    queueUrl: QueueUrl,
    destroy: async () => {
      await client.send(new DeleteQueueCommand({ QueueUrl }));
    },
  };
}
