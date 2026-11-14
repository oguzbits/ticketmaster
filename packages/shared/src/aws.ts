/** Resource names of the AWS-compatible services (queues, bucket). Local and deployed alike. */
export const QUEUE_NAME = {
  BOOKING_EVENTS: 'booking-events',
  BOOKING_EVENTS_DLQ: 'booking-events-dlq',
} as const;

/** Redrive and polling policy of the queues: a message is received at most MAX_RECEIVE_COUNT times. */
export const QUEUE_POLICY = {
  MAX_RECEIVE_COUNT: 5,
  VISIBILITY_TIMEOUT_SECONDS: 120,
  LONG_POLL_SECONDS: 20,
} as const;

export const BUCKET_NAME = {
  TICKETS: 'tickets',
} as const;

/**
 * The AWS-compatible resources of the system, declared once. `scripts/infrastructure.mjs` applies
 * this to the emulator (Compose one-shot `aws-init`) or to a real account. A queue's dead-letter
 * queue must be declared before it.
 */
export const INFRASTRUCTURE = {
  queues: [
    { name: QUEUE_NAME.BOOKING_EVENTS_DLQ },
    {
      name: QUEUE_NAME.BOOKING_EVENTS,
      visibilityTimeoutSeconds: QUEUE_POLICY.VISIBILITY_TIMEOUT_SECONDS,
      redrive: {
        deadLetterQueue: QUEUE_NAME.BOOKING_EVENTS_DLQ,
        maxReceiveCount: QUEUE_POLICY.MAX_RECEIVE_COUNT,
      },
    },
  ],
  buckets: [BUCKET_NAME.TICKETS],
} as const;
