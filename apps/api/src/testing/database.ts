import { randomUUID } from 'node:crypto';

import type { BookingStatus, BookingStrategy } from '@app/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { loadEnv } from '../config/config.module.js';
import type { Database, Tx } from '../infrastructure/database/database.module.js';
import * as schema from '../infrastructure/database/schema.js';

/** Pool of the concurrency test: many parallel holds on separate connections. */
const TEST_POOL_SIZE = 60;
const TEST_SEAT_PRICE_CENTS = 1000;
const TEST_SECTION = 'A';

export function openTestDatabase(): { db: Database; close(): Promise<void> } {
  const client = postgres(loadEnv().DATABASE_URL, { max: TEST_POOL_SIZE });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

/**
 * Inserts a booking and its `booking_seats` rows (for tests that bypass `BookingsService.hold`).
 */
export async function insertTestBooking(
  db: Database | Tx,
  input: {
    id?: string;
    eventId: string;
    seatIds: readonly string[];
    userId?: string;
    strategy: BookingStrategy;
    status: BookingStatus;
    holdExpiresAt?: Date;
    ticketReadyAt?: Date | null;
    updatedAt?: Date;
  }
): Promise<string> {
  const id = input.id ?? randomUUID();
  await db.insert(schema.bookings).values({
    id,
    eventId: input.eventId,
    userId: input.userId ?? randomUUID(),
    strategy: input.strategy,
    status: input.status,
    holdExpiresAt: input.holdExpiresAt ?? new Date(),
    ticketReadyAt: input.ticketReadyAt ?? null,
    ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
  });
  if (input.seatIds.length > 0) {
    await db.insert(schema.bookingSeats).values(
      input.seatIds.map((seatId) => ({
        bookingId: id,
        eventId: input.eventId,
        seatId,
        strategy: input.strategy,
        status: input.status,
      }))
    );
  }
  return id;
}

/**
 * Creates a venue, an event and `seats` seats with random IDs, so test files never collide and
 * need no truncation.
 */
export async function createTestEvent(
  db: Database,
  input: {
    strategy: BookingStrategy;
    seats: number;
    sandboxUserId?: string;
    ownerId?: string;
    waitingRoomCapacity?: number;
    startsAt?: Date;
    name?: string;
    venueName?: string;
    priceCents?: number;
  }
): Promise<{ eventId: string; seatIds: string[] }> {
  const venueId = randomUUID();
  const eventId = randomUUID();
  const seatIds = Array.from({ length: input.seats }, () => randomUUID());
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.venues)
      .values({ id: venueId, name: input.venueName ?? `test venue ${venueId}` });
    await tx.insert(schema.events).values({
      id: eventId,
      venueId,
      name: input.name ?? `test event ${eventId}`,
      startsAt: input.startsAt ?? new Date(),
      strategy: input.strategy,
      ownerId: input.ownerId ?? randomUUID(),
      sandboxUserId: input.sandboxUserId ?? null,
      waitingRoomCapacity: input.waitingRoomCapacity ?? null,
    });
    if (seatIds.length === 0) return;
    await tx.insert(schema.seats).values(
      seatIds.map((id, index) => ({
        id,
        eventId,
        section: TEST_SECTION,
        row: 1,
        number: index + 1,
        priceCents: input.priceCents ?? TEST_SEAT_PRICE_CENTS,
      }))
    );
  });
  return { eventId, seatIds };
}
