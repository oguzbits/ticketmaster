import { randomUUID } from 'node:crypto';

import { BOOKING_STATUS } from '@app/shared';
import { describe, expect, it } from 'vitest';

import type { TicketData } from '../domain/ticket.js';
import { renderTicketPdf } from './render-ticket-pdf.js';

const TICKET: TicketData = {
  bookingId: randomUUID(),
  status: BOOKING_STATUS.CONFIRMED,
  eventTitle: 'Şarkı Ğ İstanbul Müller',
  venueName: 'Çarşı Hall',
  startsAt: new Date('2031-05-04T18:30:00Z'),
  seat: { section: 'A', row: 3, number: 12 },
};

/**
 * pdfkit writes text as glyph IDs of the embedded font, so a spec cannot read the text back. It
 * can read what the writer declares: the font that is embedded (a subset of the DejaVu file) and
 * the booking ID, which is the title of the document (an ASCII string in the Info dictionary).
 */
const asLatin1 = (pdf: Uint8Array): string => Buffer.from(pdf).toString('latin1');

describe('renderTicketPdf', () => {
  it('produces a PDF whose title is the booking ID', async () => {
    const pdf = await renderTicketPdf(TICKET);

    expect(asLatin1(pdf).startsWith('%PDF')).toBe(true);
    expect(asLatin1(pdf)).toContain(`(${TICKET.bookingId})`);
  });

  it('embeds a font that has the glyphs of a Turkish title instead of failing or dropping them', async () => {
    const withTurkish = asLatin1(await renderTicketPdf(TICKET));
    const withAscii = asLatin1(await renderTicketPdf({ ...TICKET, eventTitle: 'Plain Title' }));

    expect(withTurkish).toMatch(/\/FontName \/[A-Z]{6}\+DejaVuSans/);
    // More distinct glyphs in the subset: the stream is longer, so the text was not replaced.
    expect(withTurkish.length).toBeGreaterThan(withAscii.length);
  });
});
