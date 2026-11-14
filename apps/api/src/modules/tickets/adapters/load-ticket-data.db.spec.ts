import { randomUUID } from 'node:crypto';

import { BOOKING_STATUS, BOOKING_STRATEGY } from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { bookings, events } from '../../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../../testing/database.js';
import { loadTicketData } from './load-ticket-data.js';

const STARTS_AT = new Date('2031-05-04T18:30:00Z');

describe('loadTicketData', () => {
  const database = openTestDatabase();
  const { db } = database;
  afterAll(() => database.close());

  it('joins the booking with its event, venue and seat', async () => {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 2,
    });
    await db.update(events).set({ startsAt: STARTS_AT }).where(eq(events.id, eventId));
    const bookingId = randomUUID();
    await db.insert(bookings).values({
      id: bookingId,
      eventId,
      seatId: seatIds[1] ?? '',
      userId: randomUUID(),
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      status: BOOKING_STATUS.CONFIRMED,
      holdExpiresAt: new Date(),
    });

    const ticket = await loadTicketData(db, bookingId);

    expect(ticket).toMatchObject({
      bookingId,
      status: BOOKING_STATUS.CONFIRMED,
      eventTitle: `test event ${eventId}`,
      seat: { section: 'A', row: 1, number: 2 },
    });
    expect(ticket?.venueName).toMatch(/^test venue /);
    expect(ticket?.startsAt).toEqual(STARTS_AT);
  });

  it('answers null for a booking that does not exist', async () => {
    expect(await loadTicketData(db, randomUUID())).toBeNull();
  });
});
