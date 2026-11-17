import { randomUUID } from 'node:crypto';

import { BOOKING_STATUS, BOOKING_STRATEGY } from '@app/shared';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { bookings } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { FakeTicketStore } from './testing/fake-ticket-store.js';
import { TicketsService } from './tickets.service.js';

// Other db specs use SPEC_NOW (2200) or real time (2026+); this epoch keeps our sweeps isolated.
const EPOCH = new Date('1991-01-01T00:00:00.000Z');
const BEFORE = new Date('1991-01-01T00:01:00.000Z');
const AFTER = new Date('1991-01-01T00:02:00.000Z');
const PDF = Buffer.from('%PDF-1.3 stored');

describe('TicketsService.deleteCancelled', () => {
  const database = openTestDatabase();
  const { db } = database;
  const store = new FakeTicketStore();
  const service = new TicketsService(db, store);

  beforeEach(() => {
    store.objects.clear();
    store.failingDeletes.clear();
    store.deletes = 0;
  });
  afterAll(() => database.close());

  async function seedBooking(options: {
    status: (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];
    ticketReadyAt: Date | null;
    updatedAt?: Date;
    storePdf?: boolean;
  }): Promise<string> {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const bookingId = randomUUID();
    await db.insert(bookings).values({
      id: bookingId,
      eventId,
      seatId: seatIds[0] ?? '',
      userId: randomUUID(),
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      status: options.status,
      holdExpiresAt: EPOCH,
      ticketReadyAt: options.ticketReadyAt,
      updatedAt: options.updatedAt ?? EPOCH,
    });
    if (options.storePdf !== false && options.ticketReadyAt !== null) {
      await store.put(bookingId, PDF);
    }
    return bookingId;
  }

  const readyAtOf = async (bookingId: string): Promise<Date | null> => {
    const [row] = await db
      .select({ ticketReadyAt: bookings.ticketReadyAt })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    if (row === undefined) throw new Error('booking missing');
    return row.ticketReadyAt;
  };

  it('deletes the PDF of cancelled bookings up to the cutoff, clears ticketReadyAt and keeps confirmed or later ones', async () => {
    const due = await seedBooking({ status: BOOKING_STATUS.CANCELLED, ticketReadyAt: EPOCH });
    const later = await seedBooking({
      status: BOOKING_STATUS.CANCELLED,
      ticketReadyAt: EPOCH,
      updatedAt: AFTER,
    });
    const alreadyCleared = await seedBooking({
      status: BOOKING_STATUS.CANCELLED,
      ticketReadyAt: null,
    });
    const confirmed = await seedBooking({ status: BOOKING_STATUS.CONFIRMED, ticketReadyAt: EPOCH });

    expect(await service.deleteCancelled(BEFORE, 10)).toBe(1);

    expect(await store.get(due)).toBeNull();
    expect(await readyAtOf(due)).toBeNull();
    expect(await store.get(later)).not.toBeNull();
    expect(await readyAtOf(later)).toEqual(EPOCH);
    expect(await readyAtOf(alreadyCleared)).toBeNull();
    expect(await store.get(confirmed)).not.toBeNull();
    expect(await readyAtOf(confirmed)).toEqual(EPOCH);
  });

  it('deletes at most the batch limit per call, oldest first, and the rest on the next one', async () => {
    const first = await seedBooking({
      status: BOOKING_STATUS.CANCELLED,
      ticketReadyAt: EPOCH,
      updatedAt: new Date(EPOCH.getTime() + 1000),
    });
    const second = await seedBooking({
      status: BOOKING_STATUS.CANCELLED,
      ticketReadyAt: EPOCH,
      updatedAt: new Date(EPOCH.getTime() + 2000),
    });
    const third = await seedBooking({
      status: BOOKING_STATUS.CANCELLED,
      ticketReadyAt: EPOCH,
      updatedAt: new Date(EPOCH.getTime() + 3000),
    });

    expect(await service.deleteCancelled(BEFORE, 2)).toBe(2);
    expect([await store.get(first), await store.get(second)]).toEqual([null, null]);
    expect(await store.get(third)).not.toBeNull();

    expect(await service.deleteCancelled(BEFORE, 2)).toBe(1);
    expect(await store.get(third)).toBeNull();
  });

  it('clears the bookings whose delete succeeded and keeps ticketReadyAt on a failing one for retry', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ok = await seedBooking({ status: BOOKING_STATUS.CANCELLED, ticketReadyAt: EPOCH });
    const failing = await seedBooking({ status: BOOKING_STATUS.CANCELLED, ticketReadyAt: EPOCH });
    store.failingDeletes.add(failing);

    await expect(service.deleteCancelled(BEFORE, 10)).rejects.toBeInstanceOf(AggregateError);

    expect(await store.get(ok)).toBeNull();
    expect(await readyAtOf(ok)).toBeNull();
    expect(await store.get(failing)).not.toBeNull();
    expect(await readyAtOf(failing)).toEqual(EPOCH);

    store.failingDeletes.delete(failing);
    expect(await service.deleteCancelled(BEFORE, 10)).toBe(1);
    expect(await store.get(failing)).toBeNull();
    expect(await readyAtOf(failing)).toBeNull();
    vi.restoreAllMocks();
  });
});
