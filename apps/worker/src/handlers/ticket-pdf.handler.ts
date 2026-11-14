import { CLOCK, type Clock } from '@app/api/clock';
import { type Database, DB, type Tx } from '@app/api/database';
import {
  loadTicketData,
  markTicketReady,
  renderTicketPdf,
  TICKET_STORE,
  type TicketStore,
} from '@app/api/tickets';
import { BOOKING_STATUS } from '@app/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  type BookingConfirmedEffect,
  type BookingConfirmedMessage,
  CONSUMER_NAME,
} from './booking-confirmed-effect.js';

/**
 * Renders the ticket of a confirmed booking, stores it under its fixed key and marks it ready, in
 * the transaction of the dedupe record. A booking that is not confirmed any more (cancelled before
 * the message arrived) gets no ticket.
 */
@Injectable()
export class TicketPdfHandler implements BookingConfirmedEffect {
  readonly consumer = CONSUMER_NAME.TICKET_PDF;
  private readonly logger = new Logger(TicketPdfHandler.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(TICKET_STORE) private readonly store: TicketStore,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async handle(message: BookingConfirmedMessage, tx: Tx): Promise<void> {
    const ticket = await loadTicketData(this.db, message.bookingId);
    if (ticket?.status !== BOOKING_STATUS.CONFIRMED) {
      this.logger.log(`booking ${message.bookingId} is not confirmed, no ticket`);
      return;
    }
    await this.store.put(message.bookingId, await renderTicketPdf(ticket));
    await markTicketReady(tx, message.bookingId, this.clock.now());
  }
}
