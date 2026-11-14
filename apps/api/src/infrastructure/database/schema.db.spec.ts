import { randomUUID } from 'node:crypto';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  type BookingStatus,
  type BookingStrategy,
  OUTBOX_MESSAGE_TYPE,
  SIMULATION_STATUS,
} from '@app/shared';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { lockOutboxRelays } from '../../modules/outbox/testing/index.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { SPEC_NOW } from '../../testing/time.js';
import type { Database } from './database.module.js';
import {
  bookings,
  events,
  outboxMessages,
  processedMessages,
  seats,
  simulationRuns,
  venues,
  venueSeats,
} from './schema.js';
import { HALL, SEED, seed } from './seed.js';

const HOLD_MS = 600_000;
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const ACTIVE_SEAT_INDEX = 'bookings_active_seat_uidx';
const UNPUBLISHED_INDEX = 'outbox_messages_unpublished_idx';
const SPEC_CONSUMER = 'schema-spec';

describe('booking schema', () => {
  const database = openTestDatabase();
  const db: Database = database.db;

  afterAll(() => database.close());

  async function book(
    strategy: BookingStrategy,
    status: BookingStatus
  ): Promise<{ eventId: string; seatId: string }> {
    const { eventId, seatIds } = await createTestEvent(db, { strategy, seats: 1 });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');
    await insertBooking(eventId, seatId, strategy, status);
    return { eventId, seatId };
  }

  async function insertBooking(
    eventId: string,
    seatId: string,
    strategy: BookingStrategy,
    status: BookingStatus
  ): Promise<void> {
    await db.insert(bookings).values({
      eventId,
      seatId,
      userId: randomUUID(),
      strategy,
      status,
      holdExpiresAt: new Date(SPEC_NOW.getTime() + HOLD_MS),
    });
  }

  it('two active bookings of a PESSIMISTIC event on one seat violate bookings_active_seat_uidx', async () => {
    const { eventId, seatId } = await book(BOOKING_STRATEGY.PESSIMISTIC, BOOKING_STATUS.HELD);

    await expect(
      insertBooking(eventId, seatId, BOOKING_STRATEGY.PESSIMISTIC, BOOKING_STATUS.PAID)
    ).rejects.toMatchObject({
      cause: { code: UNIQUE_VIOLATION, constraint_name: ACTIVE_SEAT_INDEX },
    });
  });

  it('two active NAIVE bookings on one seat are accepted', async () => {
    const { eventId, seatId } = await book(BOOKING_STRATEGY.NAIVE, BOOKING_STATUS.HELD);

    await expect(
      insertBooking(eventId, seatId, BOOKING_STRATEGY.NAIVE, BOOKING_STATUS.HELD)
    ).resolves.toBeUndefined();
  });

  it('an EXPIRED and a HELD booking on one seat are accepted', async () => {
    const { eventId, seatId } = await book(BOOKING_STRATEGY.OPTIMISTIC, BOOKING_STATUS.EXPIRED);

    await expect(
      insertBooking(eventId, seatId, BOOKING_STRATEGY.OPTIMISTIC, BOOKING_STATUS.HELD)
    ).resolves.toBeUndefined();
  });

  it('seed() twice leaves the same row counts', async () => {
    async function seededRows(): Promise<number[]> {
      const venueIds = Object.values(SEED.VENUE_IDS);
      const eventIds = Object.values(SEED.EVENT_IDS);
      const counts = await Promise.all([
        db.select({ n: count() }).from(venues).where(inArray(venues.id, venueIds)),
        db.select({ n: count() }).from(venueSeats).where(inArray(venueSeats.venueId, venueIds)),
        db.select({ n: count() }).from(events).where(inArray(events.id, eventIds)),
        db.select({ n: count() }).from(seats).where(inArray(seats.eventId, eventIds)),
      ]);
      return counts.map(([row]) => row?.n ?? -1);
    }

    await seed(db);
    const first = await seededRows();
    await seed(db);

    expect(await seededRows()).toEqual(first);
    expect(first).toEqual([2, 272, 5, 744]);
  });

  it('seed() gives the public waiting-room event its capacity', async () => {
    await seed(db);

    const [row] = await db
      .select({ capacity: events.waitingRoomCapacity })
      .from(events)
      .where(eq(events.id, SEED.EVENT_IDS.WAITING_ROOM));
    expect(row?.capacity).toBe(1);
  });

  it('seed() fills the price of a venue seat that was stored without one', async () => {
    await seed(db);
    const first = { venueId: SEED.VENUE_IDS.HALL, section: 'A', row: 1, number: 1 };
    const where = and(
      eq(venueSeats.venueId, first.venueId),
      eq(venueSeats.section, first.section),
      eq(venueSeats.row, first.row),
      eq(venueSeats.number, first.number)
    );
    await db.update(venueSeats).set({ priceCents: null }).where(where);

    await seed(db);

    const [row] = await db
      .select({ priceCents: venueSeats.priceCents })
      .from(venueSeats)
      .where(where);
    expect(row?.priceCents).toBe(HALL.sections[0]?.priceCents);
  });

  it('deleting an event deletes its simulation runs', async () => {
    const { eventId } = await createTestEvent(db, { strategy: BOOKING_STRATEGY.NAIVE, seats: 1 });
    const runId = randomUUID();
    await db.insert(simulationRuns).values({
      id: runId,
      eventId,
      strategy: BOOKING_STRATEGY.NAIVE,
      buyers: 10,
      seats: 1,
      status: SIMULATION_STATUS.QUEUED,
      startedBy: randomUUID(),
    });

    await db.delete(events).where(eq(events.id, eventId));

    const rows = await db.select().from(simulationRuns).where(eq(simulationRuns.id, runId));
    expect(rows).toEqual([]);
  });

  it('a new outbox row is unpublished with no attempts', async () => {
    const id = randomUUID();
    // A relay of another spec file would publish the row between the write and the read.
    const unlock = await lockOutboxRelays(db);
    try {
      await db.insert(outboxMessages).values({
        id,
        type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
        payload: {
          messageId: id,
          type: OUTBOX_MESSAGE_TYPE.BOOKING_CONFIRMED,
          bookingId: randomUUID(),
          eventId: randomUUID(),
          userId: randomUUID(),
          occurredAt: SPEC_NOW.toISOString(),
        },
      });

      const [row] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, id));
      expect(row).toMatchObject({ publishedAt: null, attempts: 0, lastError: null });
    } finally {
      await unlock();
    }
  });

  it('the index on unpublished outbox rows is partial', async () => {
    const rows = await db.execute<{ definition: string }>(
      sql`select indexdef as definition from pg_indexes where indexname = ${UNPUBLISHED_INDEX}`
    );

    expect(rows[0]?.definition).toMatch(/where \(?published_at is null\)?/i);
  });

  it('a consumer records a message ID once; another consumer may record the same ID', async () => {
    const messageId = randomUUID();
    await db.insert(processedMessages).values({ consumer: SPEC_CONSUMER, messageId });

    await expect(
      db.insert(processedMessages).values({ consumer: SPEC_CONSUMER, messageId })
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } });
    await db.insert(processedMessages).values({ consumer: `${SPEC_CONSUMER}-other`, messageId });
  });

  it('rejects a waiting room capacity of 0', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 0,
    });

    await expect(
      db.update(events).set({ waitingRoomCapacity: 0 }).where(eq(events.id, eventId))
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it('an event without a capacity has none', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 0,
    });

    const [row] = await db.select().from(events).where(eq(events.id, eventId));

    expect(row?.waitingRoomCapacity).toBeNull();
  });
});
