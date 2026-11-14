/**
 * Converges the queues and buckets of `INFRASTRUCTURE` (packages/shared) on an AWS-compatible
 * endpoint: a missing resource is created, a drifted queue attribute is set back, a matching
 * resource is left alone. Applying twice changes nothing. Returns what it changed.
 */

import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const MISSING_QUEUE = new Set(['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue']);

async function findQueueUrl(sqs, name) {
  try {
    return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl;
  } catch (error) {
    if (MISSING_QUEUE.has(error.name)) return undefined;
    throw error;
  }
}

const sameRedrive = (actual, wanted) => {
  if (actual === undefined) return false;
  const parsed = JSON.parse(actual);
  return (
    parsed.deadLetterTargetArn === wanted.deadLetterTargetArn &&
    Number(parsed.maxReceiveCount) === wanted.maxReceiveCount
  );
};

export async function applyInfrastructure({ queues, buckets }, { sqs, s3 }) {
  const changes = [];
  const arns = new Map();

  for (const queue of queues) {
    const wanted = {};
    if (queue.visibilityTimeoutSeconds !== undefined) {
      wanted.VisibilityTimeout = String(queue.visibilityTimeoutSeconds);
    }
    let redrive;
    if (queue.redrive) {
      redrive = {
        deadLetterTargetArn: arns.get(queue.redrive.deadLetterQueue),
        maxReceiveCount: queue.redrive.maxReceiveCount,
      };
      wanted.RedrivePolicy = JSON.stringify(redrive);
    }

    let url = await findQueueUrl(sqs, queue.name);
    if (url === undefined) {
      url = (await sqs.send(new CreateQueueCommand({ QueueName: queue.name, Attributes: wanted })))
        .QueueUrl;
      changes.push(`created queue ${queue.name}`);
    }
    const { Attributes: actual } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] })
    );
    arns.set(queue.name, actual.QueueArn);

    const drifted =
      (wanted.VisibilityTimeout !== undefined &&
        actual.VisibilityTimeout !== wanted.VisibilityTimeout) ||
      (redrive !== undefined && !sameRedrive(actual.RedrivePolicy, redrive));
    if (drifted) {
      await sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: wanted }));
      changes.push(`updated queue ${queue.name}`);
    }
  }

  for (const bucket of buckets) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (error.name !== 'NotFound') throw error;
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      changes.push(`created bucket ${bucket}`);
    }
  }
  return changes;
}
