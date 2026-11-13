import { eq } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { seats } from '../../../infrastructure/database/schema.js';
import {
  HOLD_OUTCOME,
  type HoldInput,
  type HoldResult,
  type SeatReservation,
} from '../domain/seat-reservation.js';
import { insertHold, isSeatTaken } from './insert-hold.js';

/** Locks the seat row for the length of the transaction; competing holds queue behind it. */
export class PessimisticReservation implements SeatReservation {
  constructor(private readonly db: Database) {}

  hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult> {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: seats.id }).from(seats).where(eq(seats.id, input.seatId)).for('update');
      return (await isSeatTaken(tx, input.seatId))
        ? { outcome: HOLD_OUTCOME.SEAT_TAKEN }
        : insertHold(tx, input, input.now, input.ttlSeconds);
    });
  }
}
