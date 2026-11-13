import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY } from '@app/shared';
import { afterAll, describe, expect, it } from 'vitest';

import { createTestEvent, openTestDatabase } from '../../../testing/database.js';
import { HOLD_OUTCOME } from '../domain/seat-reservation.js';
import { insertHold } from './insert-hold.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const TTL_SECONDS = 600;

describe('insertHold', () => {
  const database = openTestDatabase();
  const { db } = database;

  afterAll(() => database.close());

  const hold = (eventId: string, seatId: string) =>
    db.transaction((tx) =>
      insertHold(tx, { eventId, seatId, userId: randomUUID() }, NOW, TTL_SECONDS)
    );

  it('reports CONSTRAINT_VIOLATION when the seat already has an active booking', async () => {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');
    await hold(eventId, seatId);

    expect(await hold(eventId, seatId)).toEqual({ outcome: HOLD_OUTCOME.CONSTRAINT_VIOLATION });
  });

  it('rethrows every other database error', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });

    await expect(hold(eventId, randomUUID())).rejects.toThrow();
  });
});
