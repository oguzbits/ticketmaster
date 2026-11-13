import { randomUUID } from 'node:crypto';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  type BookingStatus,
  ROLE,
  SEAT_STATUS,
  type SeatChange,
  TRANSITION_REASON,
} from '@app/shared';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bookings,
  bookingTransitions,
  demoUsers,
  events,
  seats,
} from '../../infrastructure/database/schema.js';
import { HALL, layoutSeats, SEED, seed } from '../../infrastructure/database/seed.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { SPEC_NOW } from '../../testing/time.js';
import type { SeatChangePublisher } from '../bookings/index.js';
import {
  ACCESS_TOKEN_GRACE_SECONDS,
  DEMO_CLEANUP_BATCH,
  DemoService,
  MAX_DEMO_USERS,
} from './demo.service.js';
import { FAKE_TOKENS, FakeKeycloakAdmin } from './testing/fake-keycloak-admin.js';

const TTL_SECONDS = 3600;
const HOUR_MS = TTL_SECONDS * 1000;
const GRACE_MS = ACCESS_TOKEN_GRACE_SECONDS * 1000;
// Every cleanup test lives in its own early year: deleteExpired works on the whole table, and no
// other user (the login tests use SPEC_NOW, other specs the real clock) is due by then.
const era = (year: number): Date => new Date(`${year}-01-01T00:00:00Z`);
const STRATEGIES = Object.values(BOOKING_STRATEGY).toSorted();

describe('DemoService', () => {
  const database = openTestDatabase();
  const { db } = database;
  const keycloak = new FakeKeycloakAdmin();
  let now = SPEC_NOW;
  const clock = { now: () => now };
  const published: { change: SeatChange; bookingsLeft: number }[] = [];
  let publishFails = false;
  // Counts the user's bookings through another connection at the moment of the message, so a
  // publish before the cleanup transaction commits shows up as bookings that are still there.
  const seatChanges: SeatChangePublisher = {
    publish: async (change) => {
      const [left] = await db
        .select({ total: count() })
        .from(bookings)
        .where(eq(bookings.seatId, change.seatId));
      published.push({ change, bookingsLeft: left?.total ?? 0 });
      if (publishFails) throw new Error('redis down');
    },
  };
  const serviceWithCap = (maxUsers: number) =>
    new DemoService(db, keycloak, clock, { userTtlSeconds: TTL_SECONDS, maxUsers, seatChanges });
  const service = serviceWithCap(MAX_DEMO_USERS);

  beforeAll(() => seed(db));
  beforeEach(() => {
    now = SPEC_NOW;
  });
  afterAll(() => database.close());

  const sandboxEvents = (userId: string) =>
    db.select().from(events).where(eq(events.sandboxUserId, userId));
  const demoUserRows = (userId: string) =>
    db.select().from(demoUsers).where(eq(demoUsers.userId, userId));

  /** A demo user at time `at`, with one booking (confirmed unless told otherwise) on a public event. */
  async function loginWithBooking(
    at: Date,
    status: BookingStatus = BOOKING_STATUS.CONFIRMED
  ): Promise<{ userId: string; bookingId: string; eventId: string; seatId: string }> {
    now = at;
    const before = keycloak.created.length;
    await service.login(ROLE.CUSTOMER);
    const userId = keycloak.created[before]?.id ?? '';
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const [booking] = await db
      .insert(bookings)
      .values({
        eventId,
        seatId: seatIds[0] ?? '',
        userId,
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        status,
        holdExpiresAt: at,
      })
      .returning({ id: bookings.id });
    return { userId, bookingId: booking?.id ?? '', eventId, seatId: seatIds[0] ?? '' };
  }

  const bookingRows = (bookingId: string) =>
    db.select().from(bookings).where(eq(bookings.id, bookingId));

  describe('login', () => {
    it('creates a user with its role, stores it with an expiry and returns the grant', async () => {
      const tokens = await service.login(ROLE.ORGANIZER);

      expect(tokens).toEqual(FAKE_TOKENS);
      const created = keycloak.created.at(-1);
      expect(created).toMatchObject({ role: ROLE.ORGANIZER });
      const [row] = await demoUserRows(created?.id ?? '');
      expect(row).toMatchObject({
        role: ROLE.ORGANIZER,
        expiresAt: new Date(SPEC_NOW.getTime() + HOUR_MS),
      });
    });

    it('gives every visitor their own username and password', async () => {
      await service.login(ROLE.CUSTOMER);
      await service.login(ROLE.CUSTOMER);

      const [first, second] = keycloak.created.slice(-2);
      expect(first?.username).not.toBe(second?.username);
      expect(first?.password).not.toBe(second?.password);
    });

    it('seeds four sandbox events of the hall, one per strategy, owned by the user', async () => {
      await service.login(ROLE.CUSTOMER);
      const userId = keycloak.created.at(-1)?.id ?? '';

      const rows = await sandboxEvents(userId);

      expect(rows.map((row) => row.strategy).toSorted()).toEqual(STRATEGIES);
      for (const row of rows) {
        expect(row).toMatchObject({ venueId: SEED.VENUE_IDS.HALL, ownerId: userId });
        const [seatCount] = await db
          .select({ total: count() })
          .from(seats)
          .where(eq(seats.eventId, row.id));
        expect(seatCount?.total).toBe(layoutSeats(HALL).length);
      }
    });

    // The table is shared with the other specs, which only add rows: a cap read from it stays
    // reached, while one row more than it is free unless another spec logs in at that very moment.
    describe('with the number of demo users at the cap', () => {
      const countUsers = async () =>
        (await db.select({ total: count() }).from(demoUsers))[0]?.total ?? 0;

      it('answers 503 and creates nothing in Keycloak', async () => {
        const reached = await countUsers();
        const before = keycloak.created.length;

        await expect(serviceWithCap(reached).login(ROLE.CUSTOMER)).rejects.toBeInstanceOf(
          ServiceUnavailableException
        );

        expect(keycloak.created).toHaveLength(before);
        expect(await countUsers()).toBeGreaterThanOrEqual(reached);
      });

      it('lets the last free place in', async () => {
        const reached = await countUsers();

        await expect(serviceWithCap(reached + 1).login(ROLE.CUSTOMER)).resolves.toEqual(
          FAKE_TOKENS
        );
      });
    });

    it('deletes the Keycloak user again and keeps nothing when the grant fails', async () => {
      keycloak.failGrant = true;
      const before = keycloak.created.length;

      try {
        await expect(service.login(ROLE.CUSTOMER)).rejects.toThrow('grant refused');
      } finally {
        keycloak.failGrant = false;
      }

      const failed = keycloak.created[before]?.id ?? '';
      expect(keycloak.deleted).toContain(failed);
      expect(await demoUserRows(failed)).toEqual([]);
      expect(await sandboxEvents(failed)).toEqual([]);
    });

    it('rethrows the grant error with the failed cleanup attached, and logs the cleanup', async () => {
      keycloak.failGrant = true;
      keycloak.failDeleteOfNewUsers = true;
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const before = keycloak.created.length;

      try {
        const error = await service.login(ROLE.CUSTOMER).then(
          () => undefined,
          (rejected: Error) => rejected
        );

        expect(error?.message).toBe('grant refused');
        expect(error?.cause).toEqual(new Error('Keycloak is down'));
        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining(keycloak.created[before]?.id ?? '')
        );
      } finally {
        keycloak.failGrant = false;
        keycloak.failDeleteOfNewUsers = false;
        keycloak.failDelete.clear();
        logged.mockRestore();
      }
    });
  });

  describe('refresh', () => {
    it('hands the refresh token to Keycloak and returns the new pair', async () => {
      await expect(service.refresh('old')).resolves.toEqual(FAKE_TOKENS);

      expect(keycloak.refreshed).toContain('old');
    });
  });

  describe('deleteExpired', () => {
    it('removes only expired users: their Keycloak user, bookings, events and row', async () => {
      const start = era(2003);
      const expired = await loginWithBooking(start);
      const active = await loginWithBooking(new Date(start.getTime() + HOUR_MS / 2));
      const due = new Date(start.getTime() + HOUR_MS + GRACE_MS);

      await expect(service.deleteExpired(due)).resolves.toBe(1);

      expect(keycloak.deleted).toContain(expired.userId);
      expect(keycloak.deleted).not.toContain(active.userId);
      expect(await demoUserRows(expired.userId)).toEqual([]);
      expect(await sandboxEvents(expired.userId)).toEqual([]);
      expect(await bookingRows(expired.bookingId)).toEqual([]);
      expect(await sandboxEvents(active.userId)).toHaveLength(STRATEGIES.length);
      expect(await demoUserRows(active.userId)).toHaveLength(1);
      expect(await bookingRows(active.bookingId)).toHaveLength(1);
    });

    it('waits until the access token of the user has expired too: cleaned at expiry plus grace, not a second before', async () => {
      const { userId } = await loginWithBooking(era(2001));
      const cutoff = new Date(era(2001).getTime() + HOUR_MS + GRACE_MS);

      await expect(service.deleteExpired(new Date(cutoff.getTime() - 1000))).resolves.toBe(0);
      expect(await demoUserRows(userId)).toHaveLength(1);
      expect(keycloak.deleted).not.toContain(userId);

      await expect(service.deleteExpired(cutoff)).resolves.toBe(1);
      expect(await demoUserRows(userId)).toEqual([]);
    });

    it('removes the transitions of the bookings with them', async () => {
      const { userId, bookingId } = await loginWithBooking(era(2004));
      await db.insert(bookingTransitions).values({
        bookingId,
        toStatus: BOOKING_STATUS.CONFIRMED,
        reason: TRANSITION_REASON.CONFIRMED,
      });

      await service.deleteExpired(new Date(era(2004).getTime() + HOUR_MS + GRACE_MS));

      const [left] = await db
        .select({ total: count() })
        .from(bookingTransitions)
        .where(eq(bookingTransitions.bookingId, bookingId));
      expect(left?.total).toBe(0);
      expect(await demoUserRows(userId)).toEqual([]);
    });

    it('cleans the others and keeps the row of a user whose Keycloak call fails, for the next run', async () => {
      const start = era(2005);
      const stuck = await loginWithBooking(start);
      const fine = await loginWithBooking(start);
      const due = new Date(start.getTime() + HOUR_MS + GRACE_MS);
      keycloak.failDelete.add(stuck.userId);

      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      try {
        await expect(service.deleteExpired(due)).rejects.toThrow(AggregateError);
        // The cause is in the log, not only inside the AggregateError: user ID and error name.
        expect(logged).toHaveBeenCalledWith(expect.stringContaining(stuck.userId));
        expect(logged).toHaveBeenCalledWith(expect.stringContaining('Error'));
        expect(logged).toHaveBeenCalledTimes(1);
      } finally {
        keycloak.failDelete.clear();
        logged.mockRestore();
      }

      expect(await demoUserRows(fine.userId)).toEqual([]);
      expect(await sandboxEvents(fine.userId)).toEqual([]);
      expect(await demoUserRows(stuck.userId)).toHaveLength(1);
      expect(await sandboxEvents(stuck.userId)).toHaveLength(STRATEGIES.length);

      await expect(service.deleteExpired(due)).resolves.toBe(1);
      expect(await demoUserRows(stuck.userId)).toEqual([]);
    });

    it('takes at most one batch per run and drains the rest over the next runs', async () => {
      const expiresAt = era(2002);
      const userIds = Array.from({ length: DEMO_CLEANUP_BATCH + 1 }, () => randomUUID());
      await db
        .insert(demoUsers)
        .values(userIds.map((userId) => ({ userId, role: ROLE.CUSTOMER, expiresAt })));
      const due = new Date(expiresAt.getTime() + GRACE_MS);

      await expect(service.deleteExpired(due)).resolves.toBe(DEMO_CLEANUP_BATCH);
      const [left] = await db
        .select({ total: count() })
        .from(demoUsers)
        .where(eq(demoUsers.expiresAt, expiresAt));
      expect(left?.total).toBe(1);

      await expect(service.deleteExpired(due)).resolves.toBe(1);
      await expect(service.deleteExpired(due)).resolves.toBe(0);
    });

    describe('seat changes', () => {
      const dueAfter = (start: Date) => new Date(start.getTime() + HOUR_MS + GRACE_MS);
      const publishedFor = (seatId: string) =>
        published.filter(({ change }) => change.seatId === seatId);

      it('frees the seats the user still held, sold or booked on a public event, after the commit', async () => {
        const start = era(2006);
        const holder = await loginWithBooking(start, BOOKING_STATUS.HELD);
        const buyer = await loginWithBooking(start, BOOKING_STATUS.CONFIRMED);
        const gone = await loginWithBooking(start, BOOKING_STATUS.CANCELLED);

        await service.deleteExpired(dueAfter(start));

        for (const { eventId, seatId } of [holder, buyer]) {
          expect(publishedFor(seatId)).toEqual([
            {
              change: {
                eventId,
                seatId,
                status: SEAT_STATUS.AVAILABLE,
                at: dueAfter(start).toISOString(),
              },
              bookingsLeft: 0,
            },
          ]);
        }
        // A cancelled booking did not occupy its seat: nothing changes for the viewers.
        expect(publishedFor(gone.seatId)).toEqual([]);
      });

      it('publishes the status the seat still has when another booking occupies it (NAIVE)', async () => {
        const start = era(2009);
        const leaving = await loginWithBooking(start, BOOKING_STATUS.HELD);
        await db.insert(bookings).values({
          eventId: leaving.eventId,
          seatId: leaving.seatId,
          userId: randomUUID(),
          strategy: BOOKING_STRATEGY.NAIVE,
          status: BOOKING_STATUS.CONFIRMED,
          holdExpiresAt: start,
        });

        await service.deleteExpired(dueAfter(start));

        expect(publishedFor(leaving.seatId).map(({ change }) => change.status)).toEqual([
          SEAT_STATUS.SOLD,
        ]);
      });

      it('sends nothing for a seat of the user’s own sandbox event, nobody else could see it', async () => {
        const start = era(2008);
        const { userId } = await loginWithBooking(start);
        const [sandbox] = await sandboxEvents(userId);
        const [seat] = await db
          .select()
          .from(seats)
          .where(eq(seats.eventId, sandbox?.id ?? ''));
        await db.insert(bookings).values({
          eventId: seat?.eventId ?? '',
          seatId: seat?.id ?? '',
          userId,
          strategy: sandbox?.strategy ?? BOOKING_STRATEGY.PESSIMISTIC,
          status: BOOKING_STATUS.HELD,
          holdExpiresAt: start,
        });

        await service.deleteExpired(dueAfter(start));

        expect(publishedFor(seat?.id ?? '')).toEqual([]);
      });

      it('does not fail the cleanup when the publish fails, and logs it', async () => {
        const start = era(2007);
        const { userId, bookingId } = await loginWithBooking(start);
        publishFails = true;
        const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        try {
          await expect(service.deleteExpired(dueAfter(start))).resolves.toBe(1);
          expect(logged).toHaveBeenCalledWith(expect.stringContaining(userId));
        } finally {
          publishFails = false;
          logged.mockRestore();
        }

        expect(await bookingRows(bookingId)).toEqual([]);
      });
    });

    it('does nothing when nobody is due', async () => {
      await expect(service.deleteExpired(era(2000))).resolves.toBe(0);
    });
  });
});
