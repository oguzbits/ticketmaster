import { randomUUID } from 'node:crypto';

import { OUTBOX_MESSAGE_TYPE, QueueMessageSchema } from '@app/shared';
import { describe, expect, it } from 'vitest';

function bookingConfirmed() {
  return {
    messageId: randomUUID(),
    type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
    bookingId: randomUUID(),
    eventId: randomUUID(),
    userId: randomUUID(),
    occurredAt: '2026-01-01T12:00:00.000Z',
  };
}

describe('QueueMessageSchema', () => {
  it('parses a BOOKING_CONFIRMED message', () => {
    const message = bookingConfirmed();

    expect(QueueMessageSchema.parse(message)).toEqual(message);
  });

  it('rejects an unknown type, so the consumer can send it to the dead-letter queue', () => {
    const result = QueueMessageSchema.safeParse({ ...bookingConfirmed(), type: 'SOMETHING_ELSE' });

    expect(result.success).toBe(false);
  });

  it.each(['messageId', 'bookingId', 'eventId', 'userId'])('requires %s to be a UUID', (field) => {
    const result = QueueMessageSchema.safeParse({ ...bookingConfirmed(), [field]: 'not-a-uuid' });

    expect(result.success).toBe(false);
  });

  it('requires an ISO timestamp', () => {
    const result = QueueMessageSchema.safeParse({ ...bookingConfirmed(), occurredAt: 'yesterday' });

    expect(result.success).toBe(false);
  });

  it('drops fields that are not part of the contract, so personal data does not pass through', () => {
    const parsed = QueueMessageSchema.parse({ ...bookingConfirmed(), email: 'a@example.org' });

    expect(parsed).not.toHaveProperty('email');
  });
});
