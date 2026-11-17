import { asc, inArray } from 'drizzle-orm';

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

/** Locks all requested seat rows in canonical ID order; competing holds queue behind them without deadlocking. */
export class PessimisticReservation implements SeatReservation {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService
  ) {}

  hold(input: HoldInput & { now: Date; ttlSeconds: number }): Promise<HoldResult> {
    const ordered = [...input.seatIds].sort();
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: seats.id })
        .from(seats)
        .where(inArray(seats.id, ordered))
        .orderBy(asc(seats.id))
        .for('update');
      return (await anySeatTaken(tx, ordered))
        ? { outcome: HOLD_OUTCOME.SEAT_TAKEN }
        : insertHold(tx, { ...input, seatIds: ordered }, this.audit);
    });
  }
}
