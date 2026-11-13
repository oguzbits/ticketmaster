import { BOOKING_STRATEGY, type BookingStrategy } from '@app/shared';
import { sql } from 'drizzle-orm';

import type { Database } from './database.module.js';
import { events, seats, venues, venueSeats } from './schema.js';

/** Fixed IDs make the seed idempotent: a second run finds every row and writes nothing. */
export const SEED = {
  VENUE_IDS: {
    HALL: '00000000-0000-4000-8000-000000000001',
    CLUB: '00000000-0000-4000-8000-000000000002',
  },
  EVENT_IDS: {
    NAIVE: '00000000-0000-4000-8000-0000000000a1',
    PESSIMISTIC: '00000000-0000-4000-8000-0000000000a2',
    OPTIMISTIC: '00000000-0000-4000-8000-0000000000a3',
    REDIS_LOCK: '00000000-0000-4000-8000-0000000000a4',
  },
  // Owner of the public events: the platform itself, not a user.
  OWNER_ID: '00000000-0000-4000-8000-0000000000ff',
} as const;

interface Layout {
  sections: { name: string; priceCents: number }[];
  rows: number;
  seatsPerRow: number;
}

/** The hall's seats and prices; the sandbox events of the demo login reuse them. */
export const HALL: Layout = {
  sections: [
    { name: 'A', priceCents: 9000 },
    { name: 'B', priceCents: 7000 },
    { name: 'C', priceCents: 5000 },
    { name: 'D', priceCents: 3000 },
  ],
  rows: 5,
  seatsPerRow: 10,
};
const CLUB: Layout = { sections: [{ name: 'FLOOR', priceCents: 4500 }], rows: 6, seatsPerRow: 12 };

// shortcut: fixed dates, so the demo events eventually lie in the past; upgrade when the demo goes
// live (phase 5) by deriving the date from the injected clock.
export const STARTS_AT = new Date('2027-06-01T19:00:00Z');

const PUBLIC_EVENTS: { id: string; name: string; strategy: BookingStrategy; venueId: string }[] = [
  {
    id: SEED.EVENT_IDS.NAIVE,
    name: 'Club Night (naive)',
    strategy: BOOKING_STRATEGY.NAIVE,
    venueId: SEED.VENUE_IDS.CLUB,
  },
  {
    id: SEED.EVENT_IDS.PESSIMISTIC,
    name: 'Symphony Evening (pessimistic)',
    strategy: BOOKING_STRATEGY.PESSIMISTIC,
    venueId: SEED.VENUE_IDS.HALL,
  },
  {
    id: SEED.EVENT_IDS.OPTIMISTIC,
    name: 'Jazz Gala (optimistic)',
    strategy: BOOKING_STRATEGY.OPTIMISTIC,
    venueId: SEED.VENUE_IDS.HALL,
  },
  {
    id: SEED.EVENT_IDS.REDIS_LOCK,
    name: 'Indie Showcase (Redis lock)',
    strategy: BOOKING_STRATEGY.REDIS_LOCK,
    venueId: SEED.VENUE_IDS.CLUB,
  },
];

/** Every seat of a layout: section, row and number, with the section's price. */
export function layoutSeats(layout: Layout) {
  return layout.sections.flatMap(({ name, priceCents }) =>
    Array.from({ length: layout.rows }, (_, row) =>
      Array.from({ length: layout.seatsPerRow }, (_, seat) => ({
        section: name,
        row: row + 1,
        number: seat + 1,
        priceCents,
      }))
    ).flat()
  );
}

/** Two venues with seat templates and four public events, one per strategy. Safe to repeat. */
export async function seed(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(venues)
      .values([
        { id: SEED.VENUE_IDS.HALL, name: 'Concert Hall' },
        { id: SEED.VENUE_IDS.CLUB, name: 'Riverside Club' },
      ])
      .onConflictDoNothing();
    const templates = [
      { venueId: SEED.VENUE_IDS.HALL, layout: HALL },
      { venueId: SEED.VENUE_IDS.CLUB, layout: CLUB },
    ];
    await tx
      .insert(venueSeats)
      .values(
        templates.flatMap(({ venueId, layout }) =>
          layoutSeats(layout).map((seat) => ({ venueId, ...seat }))
        )
      )
      // Also fills the price of template rows that were written before the column existed.
      .onConflictDoUpdate({
        target: [venueSeats.venueId, venueSeats.section, venueSeats.row, venueSeats.number],
        set: { priceCents: sql`excluded.price_cents` },
      });
    await tx
      .insert(events)
      .values(
        PUBLIC_EVENTS.map((event) => ({ ...event, startsAt: STARTS_AT, ownerId: SEED.OWNER_ID }))
      )
      .onConflictDoNothing();
    for (const event of PUBLIC_EVENTS) {
      const layout = event.venueId === SEED.VENUE_IDS.HALL ? HALL : CLUB;
      // The unique seat position per event makes a repeat a no-op.
      await tx
        .insert(seats)
        .values(layoutSeats(layout).map((seat) => ({ ...seat, eventId: event.id })))
        .onConflictDoNothing();
    }
  });
}
