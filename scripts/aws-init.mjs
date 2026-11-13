#!/usr/bin/env node

/**
 * Creates the queues and the bucket of the local AWS emulator. Safe to run again: existing
 * resources are kept and the redrive policy is set to the current values. Runs as the one-shot
 * `aws-init` Compose service and on the host (`pnpm aws:init`). Slice E replaces it with declared
 * infrastructure.
 */

import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { BUCKET_NAME, QUEUE_NAME, QUEUE_POLICY } from '../packages/shared/dist/index.js';

const config = {
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:45660',
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
};
const sqs = new SQSClient(config);
const s3 = new S3Client({ ...config, forcePathStyle: true });

const { QueueUrl: dlqUrl } = await sqs.send(
  new CreateQueueCommand({ QueueName: QUEUE_NAME.BOOKING_EVENTS_DLQ })
);
const { Attributes } = await sqs.send(
  new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] })
);

const { QueueUrl } = await sqs.send(
  new CreateQueueCommand({ QueueName: QUEUE_NAME.BOOKING_EVENTS })
);
await sqs.send(
  new SetQueueAttributesCommand({
    QueueUrl,
    Attributes: {
      VisibilityTimeout: String(QUEUE_POLICY.VISIBILITY_TIMEOUT_SECONDS),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: Attributes.QueueArn,
        maxReceiveCount: QUEUE_POLICY.MAX_RECEIVE_COUNT,
      }),
    },
  })
);

try {
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET_NAME.TICKETS }));
} catch (error) {
  if (error.name !== 'NotFound') throw error;
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET_NAME.TICKETS }));
}

console.log(
  `aws-init: queues ${QUEUE_NAME.BOOKING_EVENTS}, ${QUEUE_NAME.BOOKING_EVENTS_DLQ}, bucket ${BUCKET_NAME.TICKETS} ready`
);
