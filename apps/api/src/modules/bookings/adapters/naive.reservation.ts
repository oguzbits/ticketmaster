import type { Database } from '../../../infrastructure/database/database.module.js';
import {
  HOLD_OUTCOME,
  type HoldInput,
  type HoldResult,
  type SeatReservation,
} from '../domain/seat-reservation.js';
import { insertHold, isSeatTaken } from './insert-hold.js';

/** Comparison baseline: check, then insert, with nothing between the two. It double-books. */
export class NaiveReservation implements SeatReservation {
  constructor(private readonly db: Database) {}

  hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult> {
    return this.db.transaction(async (tx) =>
      (await isSeatTaken(tx, input.seatId))
        ? { outcome: HOLD_OUTCOME.SEAT_TAKEN }
        : insertHold(tx, input, input.now, input.ttlSeconds)
    );
  }
}
