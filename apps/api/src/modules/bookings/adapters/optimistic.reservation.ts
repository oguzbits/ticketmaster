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

const MAX_ATTEMPTS = 3;

/**
 * Reads `seats.version`, then claims the seat by bumping it `where version = $read`. The bump comes
 * before the insert: a lost race shows up as zero rows and retries the attempt, instead of as a
 * unique violation after the insert. A seat still contended after the last attempt counts as taken.
 */
export class OptimisticReservation implements SeatReservation {
  constructor(private readonly db: Database) {}

  async hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await this.attempt(input);
      if (result !== null) return result;
    }
    return { outcome: HOLD_OUTCOME.SEAT_TAKEN };
  }

  /** `null` means the version moved underneath this attempt. */
  private attempt(
    input: HoldInput & { now: Date; ttlSeconds: number }
  ): Promise<HoldResult | null> {
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
      if (bumped.length === 0) return null;
      return insertHold(tx, input, input.now, input.ttlSeconds);
    });
  }
}
