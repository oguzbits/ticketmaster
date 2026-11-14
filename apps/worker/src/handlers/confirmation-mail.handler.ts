import { type Database, DB } from '@app/api/database';
import {
  loadTicketData,
  MAIL_SENDER,
  type MailSender,
  TICKET_STORE,
  type TicketStore,
  USER_DIRECTORY,
  type UserDirectory,
} from '@app/api/tickets';
import { BOOKING_STATUS } from '@app/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  type BookingConfirmedEffect,
  type BookingConfirmedMessage,
  CONSUMER_NAME,
} from './booking-confirmed-effect.js';

/**
 * Mails the stored ticket to the user of a confirmed booking. The address is fetched by user ID at
 * send time (messages carry IDs only). Delivery is at least once: a crash between the send and the
 * dedupe commit sends the mail again, which is accepted (it is not money).
 */
@Injectable()
export class ConfirmationMailHandler implements BookingConfirmedEffect {
  readonly consumer = CONSUMER_NAME.CONFIRMATION_MAIL;
  private readonly logger = new Logger(ConfirmationMailHandler.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(TICKET_STORE) private readonly store: TicketStore,
    @Inject(USER_DIRECTORY) private readonly directory: UserDirectory,
    @Inject(MAIL_SENDER) private readonly mailer: MailSender
  ) {}

  async handle(message: BookingConfirmedMessage): Promise<void> {
    const ticket = await loadTicketData(this.db, message.bookingId);
    if (ticket?.status !== BOOKING_STATUS.CONFIRMED) {
      this.logger.log(`booking ${message.bookingId} is not confirmed, no mail`);
      return;
    }
    const to = await this.directory.emailOf(message.userId);
    const pdf = await this.store.get(message.bookingId);
    // The PDF effect runs first: an absent ticket is a failure to retry, not a mail without it.
    if (pdf === null) throw new Error(`ticket of booking ${message.bookingId} is not stored`);
    const { seat } = ticket;
    await this.mailer.send({
      to,
      subject: `Your ticket for ${ticket.eventTitle}`,
      text: [
        'Your booking is confirmed.',
        '',
        ticket.eventTitle,
        ticket.venueName,
        ticket.startsAt.toUTCString(),
        `Section ${seat.section}, row ${seat.row}, seat ${seat.number}`,
        '',
        'Your ticket is attached.',
      ].join('\n'),
      attachment: { filename: `ticket-${message.bookingId}.pdf`, content: pdf },
    });
    this.logger.log(`confirmation mail of booking ${message.bookingId} sent`);
  }
}
