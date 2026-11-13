import type { SeatChange } from '@app/shared';
import type { Logger } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { bookings } from '../../../infrastructure/database/schema.js';
import type { SeatChangePublisher } from '../domain/seat-change.js';
import { ACTIVE_BOOKING_STATUSES, seatStatusOf } from '../domain/seat-status.js';

/**
 * Publishes after a commit, with the status the seat has in the database right now (the furthest
 * of its active bookings, the same rule as the event detail), not the status of the transition
 * that triggered it. Two changes that race therefore cannot leave a stale status behind, and
 * under NAIVE a seat that another booking still occupies is not announced as free.
 * The change is stored already, so a failed read or publish must not fail the request: it is
 * logged with the ID of what changed (never anything personal) and viewers catch up on their next
 * snapshot.
 */
export async function publishSeatChange(
  { db, publisher, logger }: { db: Database; publisher: SeatChangePublisher; logger: Logger },
  seat: Pick<SeatChange, 'eventId' | 'seatId' | 'at'>,
  subject: string
): Promise<void> {
  try {
    const [active] = await db
      .select({ status: bookings.status })
      .from(bookings)
      .where(
        and(
          eq(bookings.seatId, seat.seatId),
          inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES])
        )
      )
      .orderBy(desc(bookings.status))
      .limit(1);
    await publisher.publish({ ...seat, status: seatStatusOf(active?.status ?? null) });
  } catch (error) {
    logger.error(
      `seat change of ${subject} not published: ${error instanceof Error ? error.name : 'unknown error'}`
    );
  }
}
