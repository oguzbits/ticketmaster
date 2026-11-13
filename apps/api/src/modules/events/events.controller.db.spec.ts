import { randomUUID } from 'node:crypto';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  BookingSchema,
  type BookingStatus,
  EventDetailSchema,
  EventListResponseSchema,
  EventSummarySchema,
  ROLE,
  SEAT_STATUS,
} from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { bookings } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { SPEC_NOW } from '../../testing/time.js';
import { TOKEN_VERIFIER } from '../auth/index.js';

const STRATEGY = BOOKING_STRATEGY.PESSIMISTIC;
const SANDBOX_OWNER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const OTHER_USER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const OWNER_TOKEN = 'sandbox-owner';
const OTHER_TOKEN = 'other-user';
const ADMIN_TOKEN = 'admin';
const ORGANIZER_TOKEN = 'organizer';

describe('events endpoints', () => {
  const database = openTestDatabase();
  const { db } = database;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(
        fakeTokenVerifier({
          [OWNER_TOKEN]: SANDBOX_OWNER,
          [OTHER_TOKEN]: OTHER_USER,
          [ADMIN_TOKEN]: { id: randomUUID(), roles: [ROLE.ADMIN] },
          [ORGANIZER_TOKEN]: { id: randomUUID(), roles: [ROLE.ORGANIZER] },
        })
      )
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  const get = (path: string, token?: string) => {
    const call = request(app.getHttpServer())
      .get(path)
      .set('X-Forwarded-For', randomClientAddress());
    return token === undefined ? call : call.set('Authorization', `Bearer ${token}`);
  };

  async function listedIds(token?: string): Promise<string[]> {
    const response = await get('/api/events', token).expect(200);
    return EventListResponseSchema.parse(response.body).map((event) => event.id);
  }

  it('lists public events and hides sandbox events', async () => {
    const publicEvent = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });
    const sandboxEvent = await createTestEvent(db, {
      strategy: STRATEGY,
      seats: 1,
      sandboxUserId: randomUUID(),
    });

    const ids = await listedIds();

    expect(ids).toContain(publicEvent.eventId);
    expect(ids).not.toContain(sandboxEvent.eventId);
  });

  it('lists events by start time', async () => {
    await createTestEvent(db, { strategy: STRATEGY, seats: 1 });
    const response = await get('/api/events').expect(200);

    const times = EventListResponseSchema.parse(response.body).map((event) =>
      Date.parse(event.startsAt)
    );

    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('detail shows a held seat as HELD and a confirmed one as SOLD', async () => {
    const { eventId, seatIds } = await createTestEvent(db, { strategy: STRATEGY, seats: 5 });
    const [held, sold, expired, free, reheld] = seatIds;
    const book = (seatId: string | undefined, status: BookingStatus) =>
      db.insert(bookings).values({
        eventId,
        seatId: seatId ?? '',
        userId: randomUUID(),
        strategy: STRATEGY,
        status,
        holdExpiresAt: SPEC_NOW,
      });
    await book(held, BOOKING_STATUS.HELD);
    await book(sold, BOOKING_STATUS.CONFIRMED);
    await book(expired, BOOKING_STATUS.EXPIRED);
    // A seat whose earlier hold expired and was held again: the expired booking must not win.
    await book(reheld, BOOKING_STATUS.EXPIRED);
    await book(reheld, BOOKING_STATUS.HELD);

    const response = await get(`/api/events/${eventId}`).expect(200);

    const detail = EventDetailSchema.parse(response.body);
    const statusOf = (seatId: string | undefined) =>
      detail.seats.find((seat) => seat.id === seatId)?.status;
    expect(detail.id).toBe(eventId);
    expect(statusOf(held)).toBe(SEAT_STATUS.HELD);
    expect(statusOf(sold)).toBe(SEAT_STATUS.SOLD);
    expect(statusOf(expired)).toBe(SEAT_STATUS.AVAILABLE);
    expect(statusOf(free)).toBe(SEAT_STATUS.AVAILABLE);
    expect(statusOf(reheld)).toBe(SEAT_STATUS.HELD);
    expect(detail.seats).toHaveLength(5);
  });

  it('detail of a sandbox event is 404', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: STRATEGY,
      seats: 1,
      sandboxUserId: randomUUID(),
    });

    await get(`/api/events/${eventId}`).expect(404);
  });

  it('the sandbox user sees their own sandbox event in list and detail, nobody else does', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: STRATEGY,
      seats: 1,
      sandboxUserId: SANDBOX_OWNER.id,
    });

    expect(await listedIds(OWNER_TOKEN)).toContain(eventId);
    await get(`/api/events/${eventId}`, OWNER_TOKEN).expect(200);
    expect(await listedIds(OTHER_TOKEN)).not.toContain(eventId);
    await get(`/api/events/${eventId}`, OTHER_TOKEN).expect(404);
    expect(await listedIds()).not.toContain(eventId);
    await get(`/api/events/${eventId}`).expect(404);
  });

  it('detail of an unknown event is 404', async () => {
    await get(`/api/events/${randomUUID()}`).expect(404);
  });

  it('a non-UUID id is 400', async () => {
    await get('/api/events/not-a-uuid').expect(400);
  });
  describe('PATCH /api/events/:id/strategy', () => {
    const patch = (eventId: string, body: object, token?: string) => {
      const call = request(app.getHttpServer())
        .patch(`/api/events/${eventId}/strategy`)
        .set('X-Forwarded-For', randomClientAddress())
        .send(body);
      return token === undefined ? call : call.set('Authorization', `Bearer ${token}`);
    };
    const hold = async (eventId: string, seatId: string): Promise<string> => {
      const response = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('X-Forwarded-For', randomClientAddress())
        .set('Authorization', `Bearer ${OTHER_TOKEN}`)
        .send({ eventId, seatId })
        .expect(201);
      return BookingSchema.parse(response.body).id;
    };
    const strategyOfBooking = async (bookingId: string) =>
      (await db.select().from(bookings).where(eq(bookings.id, bookingId)))[0]?.strategy;

    it('is for admins only: no token is 401, a customer and an organizer are 403, nothing changes', async () => {
      const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });
      const body = { strategy: BOOKING_STRATEGY.NAIVE };

      await patch(eventId, body).expect(401);
      await patch(eventId, body, OTHER_TOKEN).expect(403);
      await patch(eventId, body, ORGANIZER_TOKEN).expect(403);

      const detail = await get(`/api/events/${eventId}`).expect(200);
      expect(EventDetailSchema.parse(detail.body).strategy).toBe(STRATEGY);
    });

    it('switches the strategy: the next hold uses it, an earlier booking keeps its own', async () => {
      const { eventId, seatIds } = await createTestEvent(db, { strategy: STRATEGY, seats: 2 });
      const before = await hold(eventId, seatIds[0] ?? '');

      const response = await patch(
        eventId,
        { strategy: BOOKING_STRATEGY.NAIVE },
        ADMIN_TOKEN
      ).expect(200);
      const after = await hold(eventId, seatIds[1] ?? '');

      expect(EventSummarySchema.parse(response.body)).toMatchObject({
        id: eventId,
        strategy: BOOKING_STRATEGY.NAIVE,
      });
      expect(await strategyOfBooking(before)).toBe(STRATEGY);
      expect(await strategyOfBooking(after)).toBe(BOOKING_STRATEGY.NAIVE);
    });

    it('answers 404 for an unknown event and 400 for a bad ID or strategy', async () => {
      const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });

      await patch(randomUUID(), { strategy: BOOKING_STRATEGY.NAIVE }, ADMIN_TOKEN).expect(404);
      await patch('not-a-uuid', { strategy: BOOKING_STRATEGY.NAIVE }, ADMIN_TOKEN).expect(400);
      await patch(eventId, { strategy: 'FAST' }, ADMIN_TOKEN).expect(400);
    });
  });
});
