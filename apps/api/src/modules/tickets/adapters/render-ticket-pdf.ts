import { createRequire } from 'node:module';

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

import type { TicketData } from '../domain/ticket.js';

const require = createRequire(import.meta.url);
// pdfkit's built-in fonts cannot draw every letter of an event title (Turkish ş ğ İ among them), so
// the ticket embeds DejaVu Sans, which has them.
const FONT = {
  REGULAR: require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'),
  BOLD: require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'),
} as const;

const QR_SIZE = 180;
const MARGIN = 56;
const TITLE_SIZE = 24;
const BODY_SIZE = 14;
const SMALL_SIZE = 9;

/** One A5-sized page: event, place, time, seat and a QR code of the booking ID. */
export async function renderTicketPdf(ticket: TicketData): Promise<Uint8Array> {
  const qr = await QRCode.toBuffer(ticket.bookingId, { type: 'png', margin: 1, width: QR_SIZE });
  const doc = new PDFDocument({
    size: 'A5',
    margin: MARGIN,
    info: { Title: ticket.bookingId, Author: 'ticketmaster-klon' },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Uint8Array>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.font(FONT.BOLD).fontSize(TITLE_SIZE).text(ticket.eventTitle).moveDown(0.5);
  doc
    .font(FONT.REGULAR)
    .fontSize(BODY_SIZE)
    .text(ticket.venueName)
    .text(ticket.startsAt.toUTCString())
    .moveDown(0.5)
    .text(`Section ${ticket.seat.section}, row ${ticket.seat.row}, seat ${ticket.seat.number}`)
    .moveDown();
  doc.image(qr, { width: QR_SIZE });
  doc.fontSize(SMALL_SIZE).text(`Booking ${ticket.bookingId}`);
  doc.end();
  return done;
}
