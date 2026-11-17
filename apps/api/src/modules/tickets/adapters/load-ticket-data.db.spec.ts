import { randomUUID } from 'node:crypto';

import { BOOKING_STATUS, BOOKING_STRATEGY } from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { events } from '../../../infrastructure/database/schema.js';
import { createTestEvent, insertTestBooking, openTestDatabase } from '../../../testing/database.js';
import { loadTicketData } from './load-ticket-data.js';

const STARTS_AT = new Date('2031-05-04T18:30:00Z');

describe('loadTicketData', () => {
  const database = openTestDatabase();
  const { db } = database;
  afterAll(() => database.close());

  it('joins the booking with its event, venue and ordered seats', async () => {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 3,
    });
    await db.update(events).set({ startsAt: STARTS_AT }).where(eq(events.id, eventId));
    const bookingId = await insertTestBooking(db, {
      eventId,
      seatIds: [seatIds[2] ?? '', seatIds[1] ?? ''],
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      status: BOOKING_STATUS.CONFIRMED,
    });

    const ticket = await db.transaction((tx) => loadTicketData(tx, bookingId));

    expect(ticket).toMatchObject({
      bookingId,
      status: BOOKING_STATUS.CONFIRMED,
      eventTitle: `test event ${eventId}`,
      seats: [
        { section: 'A', row: 1, number: 2 },
        { section: 'A', row: 1, number: 3 },
      ],
    });
    expect(ticket?.venueName).toMatch(/^test venue /);
    expect(ticket?.startsAt).toEqual(STARTS_AT);
  });

  it('answers null for a booking that does not exist', async () => {
    expect(await db.transaction((tx) => loadTicketData(tx, randomUUID()))).toBeNull();
  });
});
