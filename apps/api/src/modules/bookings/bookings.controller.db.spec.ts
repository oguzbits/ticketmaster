import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  BookingListResponseSchema,
  BookingSchema,
  type BookingStatus,
  type BookingStrategy,
  IDEMPOTENCY_KEY_HEADER,
  ROLE,
  TRANSITION_REASON,
} from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { loadEnv } from '../../config/config.module.js';
import { CLOCK } from '../../core/clock.js';
import { bookings } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { SPEC_NOW } from '../../testing/time.js';
import { TOKEN_VERIFIER } from '../auth/index.js';
import type { PaymentProvider } from './domain/payment-provider.js';
import { PAYMENT_PROVIDER } from './domain/payment-provider.js';

const ALICE = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const BOB = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const ORGANIZER = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const ADMIN = { id: randomUUID(), roles: [ROLE.ADMIN] };
// Customers that only the list test uses, so the other tests' bookings do not show up in it.
const DORA = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const ELI = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const NEWCOMER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const FRIDA = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const TOKENS = {
  alice: ALICE,
  bob: BOB,
  dora: DORA,
  eli: ELI,
  frida: FRIDA,
  newcomer: NEWCOMER,
  organizer: ORGANIZER,
  admin: ADMIN,
};
type Caller = keyof typeof TOKENS;

// A request on a loaded machine can take longer than a second to reach the database.
const SLOW_REQUEST_MS = 1200;
const LOCK_WAIT_TIMEOUT_MS = 10_000;

// The payment key column is unique over the whole table and the header must be a UUID: one random
// UUID per name and run; the same name gives the same key again.
const KEYS = new Map<string, string>();
const key = (name: string): string => {
  const known = KEYS.get(name);
  if (known !== undefined) return known;
  const fresh = randomUUID();
  KEYS.set(name, fresh);
  return fresh;
};

describe('booking endpoints', () => {
  const database = openTestDatabase();
  const { db } = database;
  const { HOLD_TTL_SECONDS } = loadEnv();
  const charges: Parameters<PaymentProvider['charge']>[0][] = [];
  let paymentSucceeds = true;
  const provider: PaymentProvider = {
    charge: (input) => {
      charges.push(input);
      return Promise.resolve({ succeeded: paymentSucceeds });
    },
  };
  let now = SPEC_NOW;
  let verifyDelayMs = 0;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue({
        verify: async (token: string) => {
          await delay(verifyDelayMs);
          return fakeTokenVerifier(TOKENS).verify(token);
        },
      })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(provider)
      .overrideProvider(CLOCK)
      .useValue({ now: () => now })
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });
  beforeEach(() => {
    now = SPEC_NOW;
    verifyDelayMs = 0;
    paymentSucceeds = true;
    charges.length = 0;
  });

  const call = (method: 'get' | 'post', path: string, caller?: Caller) => {
    const url = `/api${path}`;
    const server = request(app.getHttpServer());
    const pending = (method === 'get' ? server.get(url) : server.post(url)).set(
      'X-Forwarded-For',
      randomClientAddress()
    );
    return caller === undefined ? pending : pending.set('Authorization', `Bearer ${caller}`);
  };

  async function freeSeat(
    input: { sandboxUserId?: string; strategy?: BookingStrategy } = {}
  ): Promise<{ eventId: string; seatId: string }> {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
      ...input,
    });
    return { eventId, seatId: seatIds[0] ?? '' };
  }

  async function hold(caller: Caller, seat?: { eventId: string; seatId: string }) {
    const response = await call('post', '/bookings', caller)
      .send(seat ?? (await freeSeat()))
      .expect(201);
    return BookingSchema.parse(response.body);
  }

  const pay = (bookingId: string, caller: Caller, idempotencyKey?: string) => {
    const pending = call('post', `/bookings/${bookingId}/payment`, caller);
    return idempotencyKey === undefined
      ? pending
      : pending.set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
  };

  async function statusOf(bookingId: string): Promise<BookingStatus | undefined> {
    const [row] = await db
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    return row?.status;
  }

  describe('access', () => {
    const someId = randomUUID();
    it.each([
      ['post', '/bookings'],
      ['post', `/bookings/${someId}/payment`],
      ['post', `/bookings/${someId}/cancel`],
      ['get', '/bookings'],
    ] as const)('%s %s: no token is 401, an organizer or an admin is 403', async (method, path) => {
      await call(method, path).expect(401);
      await call(method, path, 'organizer').expect(403);
      await call(method, path, 'admin').expect(403);
    });
  });

  describe('hold', () => {
    it('answers 201 with the booking, its seat position and the HOLD transition', async () => {
      const seat = await freeSeat();

      const booking = await hold('alice', seat);

      expect(booking).toMatchObject({
        eventId: seat.eventId,
        seatId: seat.seatId,
        status: BOOKING_STATUS.HELD,
        holdExpiresAt: new Date(SPEC_NOW.getTime() + HOLD_TTL_SECONDS * 1000).toISOString(),
        seat: { section: 'A', row: 1, number: 1 },
        transitions: [
          { fromStatus: null, toStatus: BOOKING_STATUS.HELD, reason: TRANSITION_REASON.HOLD },
        ],
      });
      const [stored] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
      expect(stored?.userId).toBe(ALICE.id);
    });

    it('answers 409 when another customer holds the seat', async () => {
      const seat = await freeSeat();
      await hold('alice', seat);

      await call('post', '/bookings', 'bob').send(seat).expect(409);
    });

    it('answers 404 for a seat of another event and 400 for a malformed body', async () => {
      const { eventId } = await freeSeat();
      const other = await freeSeat();

      await call('post', '/bookings', 'alice').send({ eventId, seatId: other.seatId }).expect(404);
      await call('post', '/bookings', 'alice').send({ eventId, seatId: 'not-a-uuid' }).expect(400);
      await call('post', '/bookings', 'alice').send({}).expect(400);
    });

    it('answers 404 for a seat of another user’s sandbox event, and nothing is held', async () => {
      const seat = await freeSeat({ sandboxUserId: ALICE.id });

      await call('post', '/bookings', 'bob').send(seat).expect(404);
      await hold('alice', seat);
    });

    it('answers 409 when the database refuses a hold that raced past the seat check', async () => {
      const seat = await freeSeat({ strategy: BOOKING_STRATEGY.OPTIMISTIC });
      let response: Promise<request.Response> | undefined;
      verifyDelayMs = SLOW_REQUEST_MS;

      // An uncommitted active booking of the seat: the request's seat check cannot see it, so its
      // insert waits on the unique index and fails once this transaction commits.
      await db.transaction(async (tx) => {
        await tx.insert(bookings).values({
          ...seat,
          userId: BOB.id,
          strategy: BOOKING_STRATEGY.OPTIMISTIC,
          status: BOOKING_STATUS.HELD,
          holdExpiresAt: SPEC_NOW,
        });
        response = call('post', '/bookings', 'alice')
          .send(seat)
          .then((answer) => answer);
        await vi.waitFor(async () => {
          const waiting = await db.execute(
            sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike 'insert into "bookings"%'`
          );
          expect(waiting.length).toBeGreaterThan(0);
        }, LOCK_WAIT_TIMEOUT_MS);
      });

      expect((await response)?.status).toBe(409);
    });

    // The body schema strips an unknown `userId`, so flipping the spread order in the controller is
    // not observable here; only a controller that read the raw body would be, and none does.
    it('takes the user from the token, never from the body', async () => {
      const seat = await freeSeat();

      const response = await call('post', '/bookings', 'alice')
        .send({ ...seat, userId: BOB.id })
        .expect(201);

      const [stored] = await db
        .select({ userId: bookings.userId })
        .from(bookings)
        .where(eq(bookings.id, BookingSchema.parse(response.body).id));
      expect(stored?.userId).toBe(ALICE.id);
    });
  });

  describe('payment', () => {
    it.each([
      ['a missing key', undefined],
      ['an empty key', ''],
      ['a key over 128 characters', 'k'.repeat(129)],
      ['a key that is not a UUID', '1'],
    ])('answers 400 for %s and charges nothing', async (_name, idempotencyKey) => {
      const { id } = await hold('alice');

      await pay(id, 'alice', idempotencyKey).expect(400);

      expect(charges).toHaveLength(0);
      expect(await statusOf(id)).toBe(BOOKING_STATUS.HELD);
    });

    it('answers 400 for a booking ID that is not a UUID', async () => {
      await pay('not-a-uuid', 'alice', key('malformed')).expect(400);
    });

    it('charges once per key and answers the same again', async () => {
      const { id } = await hold('alice');

      const first = await pay(id, 'alice', key('twice')).expect(200);
      const second = await pay(id, 'alice', key('twice')).expect(200);

      expect(charges).toHaveLength(1);
      expect(BookingSchema.parse(first.body)).toMatchObject({
        id,
        status: BOOKING_STATUS.CONFIRMED,
      });
      expect(second.body).toEqual(first.body);
    });

    it('answers 403 for the booking of another customer and changes nothing', async () => {
      const { id } = await hold('alice');

      await pay(id, 'bob', key('foreign')).expect(403);

      expect(charges).toHaveLength(0);
      expect(await statusOf(id)).toBe(BOOKING_STATUS.HELD);
    });

    it('answers 404 for an unknown booking and charges nothing', async () => {
      await pay(randomUUID(), 'alice', key('unknown')).expect(404);

      expect(charges).toHaveLength(0);
    });

    it('cancels the booking and answers 200 when the provider refuses the payment', async () => {
      const { id } = await hold('alice');
      paymentSucceeds = false;

      const response = await pay(id, 'alice', key('declined')).expect(200);

      expect(BookingSchema.parse(response.body).status).toBe(BOOKING_STATUS.CANCELLED);
      expect(charges).toHaveLength(1);
      expect(await statusOf(id)).toBe(BOOKING_STATUS.CANCELLED);
    });

    it('answers 409 for a paid booking with a new key and charges nothing more', async () => {
      const { id } = await hold('alice');
      await pay(id, 'alice', key('first')).expect(200);

      await pay(id, 'alice', key('second')).expect(409);

      expect(charges).toHaveLength(1);
      expect(await statusOf(id)).toBe(BOOKING_STATUS.CONFIRMED);
    });

    it('refuses an expired hold with 409 and charges nothing', async () => {
      const { id } = await hold('alice');
      now = new Date(SPEC_NOW.getTime() + (HOLD_TTL_SECONDS + 1) * 1000);

      await pay(id, 'alice', key('expired')).expect(409);

      expect(charges).toHaveLength(0);
      expect(await statusOf(id)).toBe(BOOKING_STATUS.HELD);
    });
  });

  describe('cancel', () => {
    it('cancels an own HELD booking', async () => {
      const { id } = await hold('alice');

      const response = await call('post', `/bookings/${id}/cancel`, 'alice').expect(200);

      expect(BookingSchema.parse(response.body).status).toBe(BOOKING_STATUS.CANCELLED);
    });

    it('cancels an own CONFIRMED booking', async () => {
      const { id } = await hold('alice');
      await pay(id, 'alice', key('cancel-confirmed')).expect(200);

      const response = await call('post', `/bookings/${id}/cancel`, 'alice').expect(200);

      expect(BookingSchema.parse(response.body).status).toBe(BOOKING_STATUS.CANCELLED);
    });

    it('answers 404 for an unknown booking', async () => {
      await call('post', `/bookings/${randomUUID()}/cancel`, 'alice').expect(404);
    });

    it('answers 409 for a booking that is already cancelled', async () => {
      const { id } = await hold('alice');
      await call('post', `/bookings/${id}/cancel`, 'alice').expect(200);

      await call('post', `/bookings/${id}/cancel`, 'alice').expect(409);
    });

    it('answers 403 for the booking of another customer and changes nothing', async () => {
      const { id } = await hold('alice');

      await call('post', `/bookings/${id}/cancel`, 'bob').expect(403);

      expect(await statusOf(id)).toBe(BOOKING_STATUS.HELD);
    });
  });

  describe('list', () => {
    it('returns only the own bookings, with the stored transitions newest first', async () => {
      const mine = await hold('dora');
      await pay(mine.id, 'dora', key('list')).expect(200);
      const theirs = await hold('eli');

      const response = await call('get', '/bookings', 'dora').expect(200);

      const list = BookingListResponseSchema.parse(response.body);
      expect(list.map(({ id }) => id)).toEqual([mine.id]);
      expect(list[0]?.transitions.map(({ reason }) => reason)).toEqual([
        TRANSITION_REASON.CONFIRMED,
        TRANSITION_REASON.PAYMENT_SUCCEEDED,
        TRANSITION_REASON.HOLD,
      ]);
      const elis = await call('get', '/bookings', 'eli').expect(200);
      expect(BookingListResponseSchema.parse(elis.body).map(({ id }) => id)).toEqual([theirs.id]);
    });

    it('orders bookings and their transitions newest first', async () => {
      const first = await hold('frida');
      now = new Date(SPEC_NOW.getTime() + 60_000);
      const second = await hold('frida');
      now = new Date(SPEC_NOW.getTime() + 120_000);
      await pay(first.id, 'frida', key('order')).expect(200);

      const response = await call('get', '/bookings', 'frida').expect(200);

      const list = BookingListResponseSchema.parse(response.body);
      expect(list.map(({ id }) => id)).toEqual([second.id, first.id]);
      expect(list[1]?.transitions.map(({ reason }) => reason)).toEqual([
        TRANSITION_REASON.CONFIRMED,
        TRANSITION_REASON.PAYMENT_SUCCEEDED,
        TRANSITION_REASON.HOLD,
      ]);
    });

    it('is an empty list for a customer without bookings', async () => {
      const response = await call('get', '/bookings', 'newcomer').expect(200);

      expect(response.body).toEqual([]);
    });
  });
});
