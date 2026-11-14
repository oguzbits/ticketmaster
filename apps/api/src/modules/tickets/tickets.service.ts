import { BOOKING_STATUS } from '@app/shared';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { bookings } from '../../infrastructure/database/schema.js';
import { TICKET_STORE, type TicketStore } from './domain/ticket.js';

@Injectable()
export class TicketsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(TICKET_STORE) private readonly store: TicketStore
  ) {}

  /**
   * The PDF of the caller's own booking. 404 for an unknown booking, 403 for one of someone else,
   * and 404 while the ticket does not exist: not stored yet, or the booking is no longer confirmed
   * (a cancelled booking keeps its PDF, but not its ticket).
   */
  async download(userId: string, bookingId: string): Promise<Uint8Array> {
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
    const pdf = await this.store.get(bookingId);
    // The flag says it is stored: an absent object is a fault of ours, not a missing ticket.
    if (pdf === null) throw new Error(`ticket of booking ${bookingId} is marked ready but absent`);
    return pdf;
  }
}
