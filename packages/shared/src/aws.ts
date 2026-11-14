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
