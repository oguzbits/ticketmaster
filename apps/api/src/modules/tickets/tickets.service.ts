import { BOOKING_STATUS, type TicketDownload } from '@app/shared';
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';

import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { bookings } from '../../infrastructure/database/schema.js';
import { PRESIGNED_TICKET_TTL_SECONDS, TICKET_STORE, type TicketStore } from './domain/ticket.js';

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(TICKET_STORE) private readonly store: TicketStore,
    @Inject(CLOCK) private readonly clock: Clock = { now: () => new Date() }
  ) {}

  /**
   * Short-lived presigned download URL for the caller's confirmed booking. 404 for an unknown
   * booking, 403 for someone else's, and 404 while the ticket does not exist (`ticketReadyAt` is
   * null or the booking is no longer confirmed).
   */
  async downloadUrl(userId: string, bookingId: string): Promise<TicketDownload> {
    const [booking] = await this.db
      .select({
        ownerId: bookings.userId,
        status: bookings.status,
        ticketReadyAt: bookings.ticketReadyAt,
      })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    if (booking === undefined) throw new NotFoundException('Booking not found');
    if (booking.ownerId !== userId) throw new ForbiddenException();
    if (booking.status !== BOOKING_STATUS.CONFIRMED || booking.ticketReadyAt === null) {
      throw new NotFoundException('The ticket is not available');
    }
    const url = await this.store.presignDownload(bookingId, PRESIGNED_TICKET_TTL_SECONDS);
    const expiresAt = new Date(
      this.clock.now().getTime() + PRESIGNED_TICKET_TTL_SECONDS * 1000
    ).toISOString();
    return { url, expiresAt };
  }

  /**
   * Deletes up to `limit` stored PDFs of cancelled bookings whose cancellation was committed at or
   * before `before`, then clears `ticketReadyAt` on those bookings. A booking whose object deletion
   * fails keeps `ticketReadyAt` so the next run retries; the others still clear.
   */
  async deleteCancelled(before: Date, limit: number): Promise<number> {
    const due = await this.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, BOOKING_STATUS.CANCELLED),
          isNotNull(bookings.ticketReadyAt),
          lte(bookings.updatedAt, before)
        )
      )
      .orderBy(asc(bookings.updatedAt))
      .limit(limit);
    if (due.length === 0) return 0;
    const deletedIds: string[] = [];
    const failures: Error[] = [];
    for (const { id } of due) {
      try {
        await this.store.delete(id);
        deletedIds.push(id);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.logger.error(`could not delete ticket PDF of booking ${id}: ${failure.name}`);
        failures.push(failure);
      }
    }
    if (deletedIds.length > 0) {
      await this.db
        .update(bookings)
        .set({ ticketReadyAt: null })
        .where(inArray(bookings.id, deletedIds));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} cancelled ticket PDFs could not be deleted`
      );
    }
    return deletedIds.length;
  }
}
