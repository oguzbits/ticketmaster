import { randomUUID } from 'node:crypto';

import type { BookingStrategy } from '@app/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { loadEnv } from '../config/config.module.js';
import type { Database } from '../infrastructure/database/database.module.js';
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
  }
): Promise<{ eventId: string; seatIds: string[] }> {
  const venueId = randomUUID();
  const eventId = randomUUID();
  const seatIds = Array.from({ length: input.seats }, () => randomUUID());
  await db.transaction(async (tx) => {
    await tx.insert(schema.venues).values({ id: venueId, name: `test venue ${venueId}` });
    await tx.insert(schema.events).values({
      id: eventId,
      venueId,
      name: `test event ${eventId}`,
      startsAt: new Date(),
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
        priceCents: TEST_SEAT_PRICE_CENTS,
      }))
    );
  });
  return { eventId, seatIds };
}
