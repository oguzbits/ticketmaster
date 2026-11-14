import type { TicketStore } from '../domain/ticket.js';

/** A ticket store in memory that counts the puts and can hide a stored ticket. */
export class FakeTicketStore implements TicketStore {
  readonly objects = new Map<string, Uint8Array>();
  puts = 0;
  /** Booking IDs whose ticket reads as absent although it was stored. */
  readonly hidden = new Set<string>();

  put(bookingId: string, pdf: Uint8Array): Promise<void> {
    this.puts += 1;
    this.objects.set(bookingId, pdf);
    return Promise.resolve();
  }

  get(bookingId: string): Promise<Uint8Array | null> {
    return Promise.resolve(
      this.hidden.has(bookingId) ? null : (this.objects.get(bookingId) ?? null)
    );
  }
}
