import type { BookingStatus } from '@app/shared';

/** What a ticket shows and what the confirmation mail needs to know about a booking. */
export interface TicketData {
  bookingId: string;
  status: BookingStatus;
  eventTitle: string;
  venueName: string;
  startsAt: Date;
  seats: { section: string; row: number; number: number }[];
}

/** Presigned ticket URLs expire quickly so forwarded links cannot be shared long-term. */
export const PRESIGNED_TICKET_TTL_SECONDS = 60;

/** The object key of a ticket: fixed per booking, so storing it twice leaves one object. */
export const ticketObjectKey = (bookingId: string): string => `tickets/${bookingId}.pdf`;

/** The download filename offered via Content-Disposition. */
export const ticketFilename = (bookingId: string): string => `ticket-${bookingId}.pdf`;

export const TICKET_STORE = Symbol('TICKET_STORE');
export interface TicketStore {
  put(bookingId: string, pdf: Uint8Array): Promise<void>;
  /** Null when the object is absent; any other failure throws. */
  get(bookingId: string): Promise<Uint8Array | null>;
  /** A short-lived download URL for the stored ticket object (does not check existence). */
  presignDownload(bookingId: string, ttlSeconds: number): Promise<string>;
  /** Removes the stored object if present; an absent object is not an error. */
  delete(bookingId: string): Promise<void>;
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
