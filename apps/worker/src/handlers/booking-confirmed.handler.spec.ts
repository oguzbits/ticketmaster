import { randomUUID } from 'node:crypto';

import { OUTBOX_MESSAGE_TYPE } from '@app/shared';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BookingConfirmedHandler } from './booking-confirmed.handler.js';

describe('BookingConfirmedHandler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the booking ID of the message and nothing else of it', async () => {
    const logged = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const message = {
      messageId: randomUUID(),
      type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
      bookingId: randomUUID(),
      eventId: randomUUID(),
      userId: randomUUID(),
      occurredAt: new Date().toISOString(),
    };

    await new BookingConfirmedHandler().handle(message);

    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain(message.bookingId);
    expect(line).not.toContain(message.userId);
  });
});
