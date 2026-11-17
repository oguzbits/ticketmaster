import { SIMULATION_STATUS } from './simulations.js';

/** Resource names of the AWS-compatible services (queues, bucket). Local and deployed alike. */
export const QUEUE_NAME = {
  BOOKING_EVENTS: 'booking-events',
  BOOKING_EVENTS_DLQ: 'booking-events-dlq',
} as const;

export type QueueName = (typeof QUEUE_NAME)[keyof typeof QUEUE_NAME];

/** Redrive and polling policy of the queues: a message is received at most MAX_RECEIVE_COUNT times. */
export const QUEUE_POLICY = {
  MAX_RECEIVE_COUNT: 5,
  VISIBILITY_TIMEOUT_SECONDS: 120,
  LONG_POLL_SECONDS: 20,
  MESSAGE_RETENTION_SECONDS: 4 * 24 * 60 * 60,
} as const;

export const BUCKET_NAME = {
  TICKETS: 'tickets',
} as const;

export const SES_IDENTITY = {
  TICKETS_FROM: 'tickets@ticketmaster-klon.invalid',
} as const;

/** Status of an SQS message move task. */
export const MOVE_TASK_STATUS = {
  COMPLETED: 'COMPLETED',
  FAILED: SIMULATION_STATUS.FAILED,
  CANCELED: 'CANCELED',
  CANCELING: 'CANCELING',
  RUNNING: SIMULATION_STATUS.RUNNING,
} as const;

export type MoveTaskStatus = (typeof MOVE_TASK_STATUS)[keyof typeof MOVE_TASK_STATUS];

export const REPLAY_STATUS = {
  ...MOVE_TASK_STATUS,
  EMPTY: 'EMPTY',
  TIMEOUT: 'TIMEOUT',
} as const;

export type ReplayStatus = (typeof REPLAY_STATUS)[keyof typeof REPLAY_STATUS];

/**
 * The AWS-compatible resources of the system, declared once. `scripts/infrastructure.mjs` applies
 * this to the emulator (Compose one-shot `aws-init`) or to a real account. A queue's dead-letter
 * queue must be declared before it.
 */
export const INFRASTRUCTURE = {
  queues: [
    {
      name: QUEUE_NAME.BOOKING_EVENTS_DLQ,
      messageRetentionSeconds: QUEUE_POLICY.MESSAGE_RETENTION_SECONDS,
    },
    {
      name: QUEUE_NAME.BOOKING_EVENTS,
      visibilityTimeoutSeconds: QUEUE_POLICY.VISIBILITY_TIMEOUT_SECONDS,
      messageRetentionSeconds: QUEUE_POLICY.MESSAGE_RETENTION_SECONDS,
      redrive: {
        deadLetterQueue: QUEUE_NAME.BOOKING_EVENTS_DLQ,
        maxReceiveCount: QUEUE_POLICY.MAX_RECEIVE_COUNT,
      },
    },
  ],
  buckets: [BUCKET_NAME.TICKETS],
  emailIdentities: [SES_IDENTITY.TICKETS_FROM],
} as const;
