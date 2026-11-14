import { randomUUID } from 'node:crypto';

import { AUDIT_ACTION, BOOKING_STRATEGY } from '@app/shared';
import { afterAll, describe, expect, it } from 'vitest';

import { createTestEvent, openTestDatabase } from '../../../testing/database.js';
import { SPEC_NOW } from '../../../testing/time.js';
import { AuditService } from '../../audit/index.js';
import { auditRows } from '../../audit/testing/index.js';
import { HOLD_OUTCOME } from '../domain/seat-reservation.js';
import { insertHold } from './insert-hold.js';

const NOW = SPEC_NOW;
const TTL_SECONDS = 600;

describe('insertHold', () => {
  const database = openTestDatabase();
  const { db } = database;

  afterAll(() => database.close());

  const audit = new AuditService(db, { now: () => NOW });
  const hold = (eventId: string, seatId: string, requestId: string | null = null) =>
    db.transaction((tx) =>
      insertHold(
        tx,
        { eventId, seatId, userId: randomUUID(), requestId, now: NOW, ttlSeconds: TTL_SECONDS },
        audit
      )
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

  it('a hold the unique index refuses leaves no audit row, the placed one has its row', async () => {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');
    const requestId = (name: string) => `${name}-${randomUUID()}`;
    const placed = requestId('placed');
    const refused = requestId('refused');

    await hold(eventId, seatId, placed);
    const second = await hold(eventId, seatId, refused);

    const rows = await auditRows(db);
    expect(second).toEqual({ outcome: HOLD_OUTCOME.CONSTRAINT_VIOLATION });
    expect(rows.filter((row) => row.requestId === placed)).toMatchObject([
      { action: AUDIT_ACTION.BOOKING_HELD },
    ]);
    expect(rows.filter((row) => row.requestId === refused)).toEqual([]);
  });

  it('rethrows every other database error', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });

    await expect(hold(eventId, randomUUID())).rejects.toThrow();
  });
});
