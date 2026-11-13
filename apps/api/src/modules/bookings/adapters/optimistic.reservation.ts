import { and, eq } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { seats } from '../../../infrastructure/database/schema.js';
import {
  HOLD_OUTCOME,
  type HoldInput,
  type HoldResult,
  type SeatReservation,
} from '../domain/seat-reservation.js';
import { insertHold, isSeatTaken } from './insert-hold.js';

/**
 * Reads `seats.version`, then claims the seat by bumping it `where version = $read`. The bump comes
 * before the insert: a lost race shows up as zero rows instead of as a unique violation after the
 * insert. The version only changes together with a committed hold, so zero rows means the seat is
 * taken and no retry is needed.
 */
export class OptimisticReservation implements SeatReservation {
  constructor(private readonly db: Database) {}

  hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult> {
    return this.db.transaction(async (tx) => {
      const [seat] = await tx
        .select({ version: seats.version })
        .from(seats)
        .where(eq(seats.id, input.seatId));
      if (seat === undefined) throw new Error(`seat ${input.seatId} vanished during a hold`);
      if (await isSeatTaken(tx, input.seatId)) return { outcome: HOLD_OUTCOME.SEAT_TAKEN };
      const bumped = await tx
        .update(seats)
        .set({ version: seat.version + 1 })
        .where(and(eq(seats.id, input.seatId), eq(seats.version, seat.version)))
        .returning({ id: seats.id });
      if (bumped.length === 0) return { outcome: HOLD_OUTCOME.SEAT_TAKEN };
      return insertHold(tx, input, input.now, input.ttlSeconds);
    });
  }
}
