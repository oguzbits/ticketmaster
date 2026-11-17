import { describe, expect, it } from 'vitest';

import { MOVE_TASK_STATUS, REPLAY_STATUS } from '../packages/shared/dist/index.js';
import { getDlqMoveTasks, replayDlq, resolveQueueInfo } from './dlq-replay.mjs';

function fakeSqs({
  queues = {
    'booking-events-dlq': {
      arn: 'arn:aws:sqs:us-east-1:000000000000:booking-events-dlq',
      depth: 3,
    },
    'booking-events': { arn: 'arn:aws:sqs:us-east-1:000000000000:booking-events', depth: 0 },
  },
  moveTasks = [
    {
      TaskHandle: 'task-123',
      Status: MOVE_TASK_STATUS.COMPLETED,
      ApproximateNumberOfMessagesMoved: 3,
      ApproximateNumberOfMessagesToMove: 3,
    },
  ],
} = {}) {
  const sent = [];
  const sqs = {
    send(command) {
      const kind = command.constructor.name;
      const input = command.input;
      sent.push({ kind, input });

      if (kind === 'GetQueueUrlCommand') {
        const q = queues[input.QueueName];
        if (!q) throw Object.assign(new Error('QueueDoesNotExist'), { name: 'QueueDoesNotExist' });
        return Promise.resolve({
          QueueUrl: `http://localhost:45660/000000000000/${input.QueueName}`,
        });
      }

      if (kind === 'GetQueueAttributesCommand') {
        const name = input.QueueUrl.split('/').pop();
        const q = queues[name];
        return Promise.resolve({
          Attributes: {
            QueueArn: q.arn,
            ApproximateNumberOfMessages: String(q.depth),
          },
        });
      }

      if (kind === 'StartMessageMoveTaskCommand') {
        return Promise.resolve({ TaskHandle: 'task-123' });
      }

      if (kind === 'ListMessageMoveTasksCommand') {
        return Promise.resolve({ Results: moveTasks });
      }

      throw new Error(`Unexpected command: ${kind}`);
    },
  };
  return { sqs, sent };
}

describe('dlq-replay', () => {
  it('resolves queue url, arn, and depth', async () => {
    const { sqs } = fakeSqs();
    const info = await resolveQueueInfo(sqs, 'booking-events-dlq');

    expect(info).toEqual({
      url: 'http://localhost:45660/000000000000/booking-events-dlq',
      arn: 'arn:aws:sqs:us-east-1:000000000000:booking-events-dlq',
      depth: 3,
    });
  });

  it('skips move task when DLQ is empty', async () => {
    const { sqs, sent } = fakeSqs({
      queues: {
        'booking-events-dlq': {
          arn: 'arn:aws:sqs:us-east-1:000000000000:booking-events-dlq',
          depth: 0,
        },
        'booking-events': { arn: 'arn:aws:sqs:us-east-1:000000000000:booking-events', depth: 0 },
      },
    });

    const result = await replayDlq({ sqs });

    expect(result.status).toBe(REPLAY_STATUS.EMPTY);
    expect(result.moved).toBe(0);
    expect(sent.some((c) => c.kind === 'StartMessageMoveTaskCommand')).toBe(false);
  });

  it('starts a move task and polls until completed', async () => {
    const { sqs, sent } = fakeSqs();

    const result = await replayDlq({ sqs, pollIntervalMs: 1 });

    expect(result.status).toBe(MOVE_TASK_STATUS.COMPLETED);
    expect(result.moved).toBe(3);
    expect(result.taskHandle).toBe('task-123');
    expect(sent.some((c) => c.kind === 'StartMessageMoveTaskCommand')).toBe(true);
    expect(sent.some((c) => c.kind === 'ListMessageMoveTasksCommand')).toBe(true);
  });

  it('reports failure when move task fails', async () => {
    const { sqs } = fakeSqs({
      moveTasks: [
        {
          TaskHandle: 'task-123',
          Status: MOVE_TASK_STATUS.FAILED,
          ApproximateNumberOfMessagesMoved: 0,
          FailureReason: 'Destination queue does not exist',
        },
      ],
    });

    const result = await replayDlq({ sqs, pollIntervalMs: 1 });

    expect(result.status).toBe(MOVE_TASK_STATUS.FAILED);
    expect(result.failureReason).toBe('Destination queue does not exist');
  });

  it('returns TIMEOUT if task does not finish within timeoutMs', async () => {
    const { sqs } = fakeSqs({
      moveTasks: [
        {
          TaskHandle: 'task-123',
          Status: MOVE_TASK_STATUS.RUNNING,
          ApproximateNumberOfMessagesMoved: 1,
          ApproximateNumberOfMessagesToMove: 3,
        },
      ],
    });

    const result = await replayDlq({ sqs, timeoutMs: 10, pollIntervalMs: 20 });

    expect(result.status).toBe(MOVE_TASK_STATUS.RUNNING);
    expect(result.moved).toBe(1);
    expect(result.message).toContain('still in progress');
  });

  it('lists existing move tasks for source queue', async () => {
    const { sqs } = fakeSqs();

    const tasks = await getDlqMoveTasks(sqs);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].TaskHandle).toBe('task-123');
  });
});
