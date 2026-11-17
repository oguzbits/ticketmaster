import type { StartSimulationRequest } from '@app/shared';
import { sql } from 'drizzle-orm';

import type { Tx } from '../../infrastructure/database/database.module.js';
import { events, seats, venues } from '../../infrastructure/database/schema.js';

const SANDBOX_SECTION = 'SIM';
const SEATS_PER_ROW = 20;
const SANDBOX_SEAT_PRICE_CENTS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Creates the admin's private sandbox event with `input.seats` generated seats; returns its ID. */
export async function insertSimulationSandboxEvent(
  tx: Tx,
  input: StartSimulationRequest,
  adminId: string,
  now: Date
): Promise<string> {
  const [venue] = await tx.select({ id: venues.id }).from(venues).orderBy(venues.name).limit(1);
  if (venue === undefined) throw new Error('a simulation needs a venue, none exists');
  const [event] = await tx
    .insert(events)
    .values({
      venueId: venue.id,
      name: `Rush ${input.strategy} ${input.buyers} buyers`,
      startsAt: new Date(now.getTime() + DAY_MS),
      strategy: input.strategy,
      ownerId: adminId,
      // Private to the admin, so the event never shows in the public list.
      sandboxUserId: adminId,
    })
    .returning({ id: events.id });
  if (event === undefined) throw new Error('event insert returned no row');
  await tx.execute(sql`
    insert into ${seats} (event_id, section, row, number, price_cents)
    select ${event.id}::uuid, ${SANDBOX_SECTION}, (n - 1) / ${SEATS_PER_ROW} + 1,
      (n - 1) % ${SEATS_PER_ROW} + 1, ${SANDBOX_SEAT_PRICE_CENTS}
    from generate_series(1, ${input.seats}::int) as n
  `);
  return event.id;
}
