import { randomUUID } from 'node:crypto';

import { AUDIT_ACTION, AUDIT_SUBJECT } from '@app/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Tx } from '../../../infrastructure/database/database.module.js';
import { bookings, bookingTransitions, events } from '../../../infrastructure/database/schema.js';
import type { AuditService } from '../../audit/index.js';
import { startHold } from '../domain/booking-state-machine.js';
import { HOLD_OUTCOME, type HoldInput, type HoldResult } from '../domain/seat-reservation.js';
import { ACTIVE_BOOKING_STATUSES } from '../domain/seat-status.js';

const ACTIVE_SEAT_INDEX = 'bookings_active_seat_uidx';
// Drizzle wraps the postgres.js server error; the fields sit on `cause`.
const ActiveSeatViolationSchema = z.object({
  code: z.literal('23505'),
  constraint_name: z.literal(ACTIVE_SEAT_INDEX),
});

export async function isSeatTaken(tx: Tx, seatId: string): Promise<boolean> {
  const [active] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.seatId, seatId), inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES])))
    .limit(1);
  return active !== undefined;
}

/**
 * Writes the HELD booking (strategy copied from the event) and its transition record. The partial
 * unique index is the last line of defense: its violation is reported, anything else is rethrown.
 * The audit row (when the hold has a request ID) goes into the same savepoint, so a refused insert
 * leaves none.
 */
export async function insertHold(
  tx: Tx,
  input: HoldInput & { now: Date; ttlSeconds: number },
  audit: AuditService
): Promise<HoldResult> {
  const { booking, record } = startHold({
    bookingId: randomUUID(),
    actorId: input.userId,
    now: input.now,
    ttlSeconds: input.ttlSeconds,
  });
  try {
    // A savepoint: a refused insert must not poison the caller's transaction (its commit would throw).
    await tx.transaction(async (savepoint) => {
      await savepoint.insert(bookings).values({
        id: booking.id,
        eventId: input.eventId,
        seatId: input.seatId,
        userId: input.userId,
        strategy: sql`(select ${events.strategy} from ${events} where ${events.id} = ${input.eventId})`,
        status: booking.status,
        holdExpiresAt: booking.holdExpiresAt,
      });
      await savepoint.insert(bookingTransitions).values(record);
      if (input.requestId !== null) {
        await audit.record(savepoint, {
          actorId: input.userId,
          action: AUDIT_ACTION.BOOKING_HELD,
          subjectType: AUDIT_SUBJECT.BOOKING,
          subjectId: booking.id,
          requestId: input.requestId,
        });
      }
    });
  } catch (error) {
    if (ActiveSeatViolationSchema.safeParse(error instanceof Error ? error.cause : null).success) {
      return { outcome: HOLD_OUTCOME.CONSTRAINT_VIOLATION };
    }
    throw error;
  }
  return {
    outcome: HOLD_OUTCOME.PLACED,
    bookingId: booking.id,
    holdExpiresAt: booking.holdExpiresAt,
  };
}
