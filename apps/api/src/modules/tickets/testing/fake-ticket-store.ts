import type { TicketStore } from '../domain/ticket.js';

/** A ticket store in memory that counts the puts and deletes and can hide or fail tickets. */
export class FakeTicketStore implements TicketStore {
  readonly objects = new Map<string, Uint8Array>();
  puts = 0;
  deletes = 0;
  /** Booking IDs whose ticket reads as absent although it was stored. */
  readonly hidden = new Set<string>();
  /** Booking IDs whose delete rejects (simulates an S3 failure). */
  readonly failingDeletes = new Set<string>();

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

  delete(bookingId: string): Promise<void> {
    this.deletes += 1;
    if (this.failingDeletes.has(bookingId)) {
      return Promise.reject(new Error(`ticket store delete failed for ${bookingId}`));
    }
    this.objects.delete(bookingId);
    return Promise.resolve();
  }
}
