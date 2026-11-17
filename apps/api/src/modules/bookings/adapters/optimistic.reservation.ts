import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { seats } from '../../../infrastructure/database/schema.js';
import type { AuditService } from '../../audit/index.js';
import {
  HOLD_OUTCOME,
  type HoldInput,
  type HoldResult,
  type SeatReservation,
} from '../domain/seat-reservation.js';
import { anySeatTaken, insertHold } from './insert-hold.js';

class SeatTakenAbort extends Error {}

/**
 * Reads `seats.version` for all requested seats, then claims each in canonical ID order by bumping
 * it `where version = $read`. Throwing `SeatTakenAbort` rolls back any earlier seat bumps if a
 * later seat in the cart lost the race, so no partial version bumps leak.
 */
export class OptimisticReservation implements SeatReservation {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService
  ) {}

  async hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult> {
    const ordered = [...input.seatIds].sort();
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: seats.id, version: seats.version })
          .from(seats)
          .where(inArray(seats.id, ordered))
          .orderBy(asc(seats.id));
        if (rows.length !== ordered.length) {
          throw new Error('one or more seats vanished during a hold');
        }
        if (await anySeatTaken(tx, ordered)) throw new SeatTakenAbort();
        for (const row of rows) {
          const bumped = await tx
            .update(seats)
            .set({ version: row.version + 1 })
            .where(and(eq(seats.id, row.id), eq(seats.version, row.version)))
            .returning({ id: seats.id });
          if (bumped.length === 0) throw new SeatTakenAbort();
        }
        return insertHold(tx, { ...input, seatIds: ordered }, this.audit);
      });
    } catch (error) {
      if (error instanceof SeatTakenAbort) return { outcome: HOLD_OUTCOME.SEAT_TAKEN };
      throw error;
    }
  }
}
