import { eq } from 'drizzle-orm';

import type { Tx } from '../../../infrastructure/database/database.module.js';
import { bookings } from '../../../infrastructure/database/schema.js';

/** Records that the ticket PDF of the booking is stored; the list shows it as `ticketReady`. */
export async function markTicketReady(tx: Tx, bookingId: string, at: Date): Promise<void> {
  await tx.update(bookings).set({ ticketReadyAt: at }).where(eq(bookings.id, bookingId));
}
