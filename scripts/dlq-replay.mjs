#!/usr/bin/env node

/**
 * Replays dead-letter queue messages back to the main booking-events queue via SQS
 * StartMessageMoveTask.
 * Usage:
 *   pnpm dlq:replay             # Replay DLQ messages to booking-events
 *   pnpm dlq:replay --status    # Check status of recent move tasks
 */

import { fileURLToPath } from 'node:url';

import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListMessageMoveTasksCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';

import { MOVE_TASK_STATUS, QUEUE_NAME, REPLAY_STATUS } from '../packages/shared/dist/index.js';

const DEPTH_ATTRIBUTE = 'ApproximateNumberOfMessages';
const ARN_ATTRIBUTE = 'QueueArn';
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

export async function resolveQueueInfo(sqs, queueName) {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!QueueUrl) throw new Error(`Queue ${queueName} has no URL`);
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: [ARN_ATTRIBUTE, DEPTH_ATTRIBUTE],
    })
  );
  return {
    url: QueueUrl,
    arn: Attributes?.[ARN_ATTRIBUTE],
    depth: Number(Attributes?.[DEPTH_ATTRIBUTE] ?? 0),
  };
}

export async function getDlqMoveTasks(sqs, sourceQueueName = QUEUE_NAME.BOOKING_EVENTS_DLQ) {
  const source = await resolveQueueInfo(sqs, sourceQueueName);
  const { Results = [] } = await sqs.send(
    new ListMessageMoveTasksCommand({ SourceArn: source.arn })
  );
  return Results;
}

export async function replayDlq({
  sqs,
  sourceQueueName = QUEUE_NAME.BOOKING_EVENTS_DLQ,
  destinationQueueName = QUEUE_NAME.BOOKING_EVENTS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const source = await resolveQueueInfo(sqs, sourceQueueName);
  const destination = await resolveQueueInfo(sqs, destinationQueueName);

  if (source.depth === 0) {
    return {
      status: REPLAY_STATUS.EMPTY,
      moved: 0,
      totalToMove: 0,
      message: `Dead-letter queue "${sourceQueueName}" is empty, nothing to replay.`,
    };
  }

  const { TaskHandle } = await sqs.send(
    new StartMessageMoveTaskCommand({
      SourceArn: source.arn,
      DestinationArn: destination.arn,
    })
  );

  const deadline = Date.now() + timeoutMs;
  let lastResult;

  while (Date.now() < deadline) {
    const { Results = [] } = await sqs.send(
      new ListMessageMoveTasksCommand({ SourceArn: source.arn })
    );
    const matching = Results.find((r) => r.TaskHandle === TaskHandle) ?? Results[0];
    if (matching) {
      lastResult = matching;
      if (
        matching.Status === MOVE_TASK_STATUS.COMPLETED ||
        matching.Status === MOVE_TASK_STATUS.FAILED ||
        matching.Status === MOVE_TASK_STATUS.CANCELED
      ) {
        return {
          status: matching.Status,
          moved: matching.ApproximateNumberOfMessagesMoved ?? 0,
          totalToMove: matching.ApproximateNumberOfMessagesToMove ?? 0,
          taskHandle: matching.TaskHandle,
          failureReason: matching.FailureReason,
          message:
            matching.Status === MOVE_TASK_STATUS.COMPLETED
              ? `Replayed ${matching.ApproximateNumberOfMessagesMoved ?? 0} messages from "${sourceQueueName}" to "${destinationQueueName}".`
              : `Move task ${matching.Status}: ${matching.FailureReason ?? 'unknown reason'}`,
        };
      }
    }
    await sleep(pollIntervalMs);
  }

  return {
    status: lastResult?.Status ?? REPLAY_STATUS.TIMEOUT,
    moved: lastResult?.ApproximateNumberOfMessagesMoved ?? 0,
    totalToMove: lastResult?.ApproximateNumberOfMessagesToMove ?? source.depth,
    taskHandle: TaskHandle,
    message: `Move task still in progress after ${timeoutMs}ms. Check status with --status.`,
  };
}

async function main() {
  const isStatus = process.argv.includes('--status') || process.argv.includes('-s');

  const config = {
    endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:45660',
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  };
  const sqs = new SQSClient(config);

  try {
    if (isStatus) {
      const tasks = await getDlqMoveTasks(sqs);
      if (tasks.length === 0) {
        console.log(`No move tasks found for "${QUEUE_NAME.BOOKING_EVENTS_DLQ}".`);
      } else {
        console.log(`Move tasks for "${QUEUE_NAME.BOOKING_EVENTS_DLQ}":`);
        for (const task of tasks) {
          console.log(
            `- Status: ${task.Status}, Moved: ${task.ApproximateNumberOfMessagesMoved ?? 0}, ToMove: ${task.ApproximateNumberOfMessagesToMove ?? 0}, Handle: ${task.TaskHandle}${task.FailureReason ? ` (${task.FailureReason})` : ''}`
          );
        }
      }
      return;
    }

    console.log(
      `Starting DLQ replay from "${QUEUE_NAME.BOOKING_EVENTS_DLQ}" to "${QUEUE_NAME.BOOKING_EVENTS}"...`
    );
    const result = await replayDlq({ sqs });
    console.log(result.message);
    if (result.status === REPLAY_STATUS.FAILED) {
      process.exitCode = 1;
    }
  } finally {
    sqs.destroy();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`DLQ replay failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
