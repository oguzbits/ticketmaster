import type { BookingStatus } from '@app/shared';

/** What a ticket shows and what the confirmation mail needs to know about a booking. */
export interface TicketData {
  bookingId: string;
  status: BookingStatus;
  eventTitle: string;
  venueName: string;
  startsAt: Date;
  seat: { section: string; row: number; number: number };
}

/** The object key of a ticket: fixed per booking, so storing it twice leaves one object. */
export const ticketObjectKey = (bookingId: string): string => `tickets/${bookingId}.pdf`;

export const TICKET_STORE = Symbol('TICKET_STORE');
export interface TicketStore {
  put(bookingId: string, pdf: Uint8Array): Promise<void>;
  /** Null when the object is absent; any other failure throws. */
  get(bookingId: string): Promise<Uint8Array | null>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');
export interface MailSender {
  send(mail: {
    to: string;
    subject: string;
    text: string;
    attachment: { filename: string; content: Uint8Array };
  }): Promise<void>;
}

export const USER_DIRECTORY = Symbol('USER_DIRECTORY');
export interface UserDirectory {
  /** The address of the user; throws when the user has none or cannot be found. */
  emailOf(userId: string): Promise<string>;
}
