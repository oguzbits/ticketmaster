import { INFRASTRUCTURE, QUEUE_POLICY } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { PROCESSED_RETENTION_SECONDS } from './outbox.service.js';

describe('outbox retention invariant', () => {
  it('keeps processed_messages longer than every declared queue retains messages', () => {
    for (const queue of INFRASTRUCTURE.queues) {
      expect(queue.messageRetentionSeconds).toBe(QUEUE_POLICY.MESSAGE_RETENTION_SECONDS);
      expect(PROCESSED_RETENTION_SECONDS).toBeGreaterThan(queue.messageRetentionSeconds);
    }
  });
});
