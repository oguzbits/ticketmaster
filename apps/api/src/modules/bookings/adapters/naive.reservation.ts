import type { Database } from '../../../infrastructure/database/database.module.js';
import type { AuditService } from '../../audit/index.js';
import {
  HOLD_OUTCOME,
  type HoldInput,
  type HoldResult,
  type SeatReservation,
} from '../domain/seat-reservation.js';
import { anySeatTaken, insertHold } from './insert-hold.js';

/** Comparison baseline: check, then insert, with nothing between the two. It double-books. */
export class NaiveReservation implements SeatReservation {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService
  ) {}

  hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult> {
    const ordered = [...input.seatIds].sort();
    return this.db.transaction(async (tx) =>
      (await anySeatTaken(tx, ordered))
        ? { outcome: HOLD_OUTCOME.SEAT_TAKEN }
        : insertHold(tx, { ...input, seatIds: ordered }, this.audit)
    );
  }
}
