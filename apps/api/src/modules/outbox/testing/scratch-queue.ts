import { randomUUID } from 'node:crypto';

import { CreateQueueCommand, DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';

/**
 * A queue of its own with a random name, so a spec never shares messages with another spec file
 * (the db specs run side by side against one emulator). `destroy` removes it.
 */
export async function createScratchQueue(
  client: SQSClient,
  visibilityTimeoutSeconds: number
): Promise<{ queueName: string; destroy: () => Promise<void> }> {
  const queueName = `spec-${randomUUID()}`;
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { VisibilityTimeout: String(visibilityTimeoutSeconds) },
    })
  );
  return {
    queueName,
    destroy: async () => {
      await client.send(new DeleteQueueCommand({ QueueUrl }));
    },
  };
}
