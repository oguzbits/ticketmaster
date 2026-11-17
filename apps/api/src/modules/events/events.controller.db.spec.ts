import { randomUUID } from 'node:crypto';

import {
  AUDIT_ACTION,
  AUDIT_LOG_LIMITS,
  AUDIT_SUBJECT,
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
import { APP_CONFIG, loadEnv } from '../../config/config.module.js';
import { CLOCK } from '../../core/clock.js';
import { CacheAside } from '../../infrastructure/cache/cache-aside.js';
import { SystemClock } from '../../infrastructure/clock/system-clock.js';
import { bookings, demoUsers } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { openTestRedis } from '../../testing/redis.js';
import { EXPIRY_SPEC_END, SPEC_NOW } from '../../testing/time.js';
import { AuditService } from '../audit/index.js';
import { auditRowsOfSubject } from '../audit/testing/index.js';
import { TOKEN_VERIFIER } from '../auth/index.js';
import { RecordingMetrics } from '../bookings/testing/recording-metrics.js';
import { EventCache } from '../event-cache/index.js';
import { EventsService } from './events.service.js';

const STRATEGY = BOOKING_STRATEGY.PESSIMISTIC;
const SANDBOX_OWNER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const OTHER_USER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const OWNER_TOKEN = 'sandbox-owner';
const OTHER_TOKEN = 'other-user';
const ADMIN_TOKEN = 'admin';
const ADMIN = { id: randomUUID(), roles: [ROLE.ADMIN] };
const ORGANIZER_TOKEN = 'organizer';
const DEMO_ADMIN = { id: randomUUID(), roles: [ROLE.ADMIN] };
const OTHER_DEMO_ADMIN = { id: randomUUID(), roles: [ROLE.ADMIN] };
const DEMO_ADMIN_TOKEN = 'demo-admin';
const OTHER_DEMO_ADMIN_TOKEN = 'other-demo-admin';
const DEMO_EXPIRES_AT = new Date('2100-01-01T00:00:00Z');

describe('events endpoints', () => {
  const database = openTestDatabase();
  const { db } = database;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CLOCK)
      .useValue({ now: () => SPEC_NOW })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(
        fakeTokenVerifier({
          [OWNER_TOKEN]: SANDBOX_OWNER,
          [OTHER_TOKEN]: OTHER_USER,
          [ADMIN_TOKEN]: ADMIN,
          [ORGANIZER_TOKEN]: { id: randomUUID(), roles: [ROLE.ORGANIZER] },
          [DEMO_ADMIN_TOKEN]: DEMO_ADMIN,
          [OTHER_DEMO_ADMIN_TOKEN]: OTHER_DEMO_ADMIN,
        })
      )
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    await db.insert(demoUsers).values(
      [DEMO_ADMIN, OTHER_DEMO_ADMIN].map(({ id }) => ({
        userId: id,
        role: ROLE.ADMIN,
        expiresAt: DEMO_EXPIRES_AT,
      }))
    );
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

  async function listedIds(token?: string, query = ''): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const separator = query === '' ? '?' : `${query}&`;
      const path = `/api/events${cursor === null ? query : `${separator}cursor=${encodeURIComponent(cursor)}`}`;
      const page = EventListResponseSchema.parse((await get(path, token).expect(200)).body);
      ids.push(...page.items.map((event) => event.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return ids;
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

  it('the list and the detail carry the capacity', async () => {
    const withRoom = await createTestEvent(db, {
      strategy: STRATEGY,
      seats: 1,
      waitingRoomCapacity: 25,
    });
    const without = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });

    const withRoomPage = EventListResponseSchema.parse(
      (await get(`/api/events?q=${encodeURIComponent(withRoom.eventId)}`).expect(200)).body
    );
    const withoutPage = EventListResponseSchema.parse(
      (await get(`/api/events?q=${encodeURIComponent(without.eventId)}`).expect(200)).body
    );
    const detail = EventDetailSchema.parse(
      (await get(`/api/events/${withRoom.eventId}`).expect(200)).body
    );

    expect(withRoomPage.items.find(({ id }) => id === withRoom.eventId)?.waitingRoomCapacity).toBe(
      25
    );
    expect(
      withoutPage.items.find(({ id }) => id === without.eventId)?.waitingRoomCapacity
    ).toBeNull();
    expect(detail.waitingRoomCapacity).toBe(25);
  });

  it('lists events by start time and breaks ties by id across keyset pages', async () => {
    const tag = `tie-${randomUUID()}`;
    const sameTime = new Date('2035-04-01T18:00:00.000Z');
    const created = await Promise.all([
      createTestEvent(db, { strategy: STRATEGY, seats: 1, name: `${tag}-a`, startsAt: sameTime }),
      createTestEvent(db, { strategy: STRATEGY, seats: 1, name: `${tag}-b`, startsAt: sameTime }),
      createTestEvent(db, { strategy: STRATEGY, seats: 1, name: `${tag}-c`, startsAt: sameTime }),
    ]);
    const expectedIds = created.map((e) => e.eventId).sort();

    const first = EventListResponseSchema.parse(
      (await get(`/api/events?q=${encodeURIComponent(tag)}&limit=2`).expect(200)).body
    );
    expect(first.items.map((e) => e.id)).toEqual(expectedIds.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();

    const second = EventListResponseSchema.parse(
      (
        await get(
          `/api/events?q=${encodeURIComponent(tag)}&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`
        ).expect(200)
      ).body
    );
    expect(second.items.map((e) => e.id)).toEqual(expectedIds.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  it('filters in PostgreSQL by query (event or venue, LIKE-escaped), date window, and maxPriceCents', async () => {
    const token = randomUUID();
    const cheapEarly = await createTestEvent(db, {
      strategy: STRATEGY,
      seats: 1,
      name: `100% Jazz ${token}`,
      venueName: `Hall_${token}`,
      startsAt: new Date('2036-05-10T19:00:00.000Z'),
      priceCents: 3000,
    });
    const priceyLater = await createTestEvent(db, {
      strategy: STRATEGY,
      seats: 1,
      name: `Rock ${token}`,
      venueName: `100% Arena ${token}`,
      startsAt: new Date('2036-05-20T19:00:00.000Z'),
      priceCents: 12000,
    });

    const byVenue = EventListResponseSchema.parse(
      (await get(`/api/events?q=${encodeURIComponent(`Arena ${token}`)}`).expect(200)).body
    );
    expect(byVenue.items.map((e) => e.id)).toEqual([priceyLater.eventId]);

    // LIKE wildcard `%` must be escaped so `100%` matches literal `100%` and not arbitrary strings.
    const wildcardSafe = EventListResponseSchema.parse(
      (await get(`/api/events?q=${encodeURIComponent(`100% Jazz ${token}`)}`).expect(200)).body
    );
    expect(wildcardSafe.items.map((e) => e.id)).toEqual([cheapEarly.eventId]);

    const byDateAndPrice = EventListResponseSchema.parse(
      (
        await get(
          `/api/events?q=${encodeURIComponent(token)}&from=2036-05-01T00:00:00.000Z&to=2036-05-15T23:59:59.000Z&maxPriceCents=5000`
        ).expect(200)
      ).body
    );
    expect(byDateAndPrice.items.map((e) => e.id)).toEqual([cheapEarly.eventId]);
  });

  it('answers 400 for malformed list query parameters', async () => {
    await get('/api/events?cursor=not-a-cursor').expect(400);
    await get(
      '/api/events?cursor=9999-99-99T00:00:00.000Z|00000000-0000-4000-8000-000000000001'
    ).expect(400);
    await get('/api/events?limit=0').expect(400);
    await get('/api/events?maxPriceCents=-10').expect(400);
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

  it('detail shows the furthest status of a seat with several active bookings (NAIVE)', async () => {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.NAIVE,
      seats: 2,
    });
    const [heldAndConfirmed, heldAndPaid] = seatIds;
    const book = (seatId: string | undefined, status: BookingStatus) =>
      db.insert(bookings).values({
        eventId,
        seatId: seatId ?? '',
        userId: randomUUID(),
        strategy: BOOKING_STRATEGY.NAIVE,
        status,
        holdExpiresAt: SPEC_NOW,
      });
    await book(heldAndConfirmed, BOOKING_STATUS.HELD);
    await book(heldAndConfirmed, BOOKING_STATUS.CONFIRMED);
    await book(heldAndPaid, BOOKING_STATUS.HELD);
    await book(heldAndPaid, BOOKING_STATUS.PAID);

    const detail = EventDetailSchema.parse((await get(`/api/events/${eventId}`).expect(200)).body);

    expect(detail.seats.map((seat) => seat.status)).toEqual([SEAT_STATUS.SOLD, SEAT_STATUS.SOLD]);
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

  it('a closed redis client still answers list and detail', async () => {
    // The db project runs with the cache off; this service has it on, against a client that is gone.
    const closed = await openTestRedis();
    await closed.quit();
    const cache = new EventCache(
      new CacheAside(closed, new RecordingMetrics(), new SystemClock()),
      {
        ...loadEnv(),
        EVENT_CACHE_TTL_SECONDS: 30,
      }
    );
    const service = new EventsService(db, app.get(AuditService), cache);
    const { eventId } = await createTestEvent(db, {
      strategy: STRATEGY,
      seats: 1,
      startsAt: new Date('2000-01-01T00:00:00.000Z'),
    });

    const list = await service.list(null);
    const detail = await service.detail(eventId, null);

    expect(list.items.map(({ id }) => id)).toContain(eventId);
    expect(detail.id).toBe(eventId);
  });

  it('detail of an unknown event is 404', async () => {
    await get(`/api/events/${randomUUID()}`).expect(404);
  });

  it('a non-UUID id is 400', async () => {
    await get('/api/events/not-a-uuid').expect(400);
  });
  describe('PATCH /api/events/:id/strategy', () => {
    const patch = (eventId: string, body: object, token?: string, requestId?: string) => {
      const call = request(app.getHttpServer())
        .patch(`/api/events/${eventId}/strategy`)
        .set('X-Forwarded-For', randomClientAddress())
        .send(body);
      const sent = requestId === undefined ? call : call.set('X-Request-Id', requestId);
      return token === undefined ? sent : sent.set('Authorization', `Bearer ${token}`);
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
    const bookingRow = async (bookingId: string) =>
      (await db.select().from(bookings).where(eq(bookings.id, bookingId)))[0];
    const strategyOfBooking = async (bookingId: string) => (await bookingRow(bookingId))?.strategy;

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
      // The expiry spec expires every hold of the table that is due on its day.
      expect((await bookingRow(before))?.holdExpiresAt.getTime()).toBeGreaterThan(
        EXPIRY_SPEC_END.getTime()
      );
      expect(await strategyOfBooking(after)).toBe(BOOKING_STRATEGY.NAIVE);
    });

    describe('audit', () => {
      const SWITCH = { strategy: BOOKING_STRATEGY.NAIVE };

      it('writes one row with the caller, the event and the request ID the client sent', async () => {
        const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });

        await patch(eventId, SWITCH, ADMIN_TOKEN, 'req-switch-1').expect(200);

        expect(await auditRowsOfSubject(db, eventId)).toMatchObject([
          {
            actorId: ADMIN.id,
            action: AUDIT_ACTION.EVENT_STRATEGY_SWITCHED,
            subjectType: AUDIT_SUBJECT.EVENT,
            subjectId: eventId,
            requestId: 'req-switch-1',
          },
        ]);
      });

      it('stores a generated request ID when the client sends none', async () => {
        const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });

        await patch(eventId, SWITCH, ADMIN_TOKEN).expect(200);

        const [row] = await auditRowsOfSubject(db, eventId);
        expect(row?.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
      });

      it.each([
        ['longer than the column limit', 'x'.repeat(AUDIT_LOG_LIMITS.REQUEST_ID_MAX + 1)],
        ['an email address', 'a@b.de'],
      ])('stores a generated request ID for a client one that is %s', async (_name, sent) => {
        const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });

        await patch(eventId, SWITCH, ADMIN_TOKEN, sent).expect(200);

        const [row] = await auditRowsOfSubject(db, eventId);
        expect(row?.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
      });

      it('writes no row for an event the caller may not touch or that does not exist', async () => {
        const sandbox = await createTestEvent(db, {
          strategy: STRATEGY,
          seats: 1,
          sandboxUserId: DEMO_ADMIN.id,
        });
        const unknown = randomUUID();

        await patch(sandbox.eventId, SWITCH, ADMIN_TOKEN).expect(404);
        await patch(unknown, SWITCH, ADMIN_TOKEN).expect(404);

        expect(await auditRowsOfSubject(db, sandbox.eventId)).toEqual([]);
        expect(await auditRowsOfSubject(db, unknown)).toEqual([]);
      });

      it('writes no row for a refused role', async () => {
        const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });

        await patch(eventId, SWITCH, OTHER_TOKEN).expect(403);

        expect(await auditRowsOfSubject(db, eventId)).toEqual([]);
      });
    });

    describe('a demo admin is scoped to their sandbox', () => {
      const strategyOf = async (eventId: string) =>
        EventDetailSchema.parse((await get(`/api/events/${eventId}`, ADMIN_TOKEN).expect(200)).body)
          .strategy;
      const naive = { strategy: BOOKING_STRATEGY.NAIVE };

      it('cannot switch a public event: 404, the strategy stays', async () => {
        const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });

        await patch(eventId, naive, DEMO_ADMIN_TOKEN).expect(404);

        expect(await strategyOf(eventId)).toBe(STRATEGY);
      });

      it('switches the strategy of their own sandbox event', async () => {
        const { eventId } = await createTestEvent(db, {
          strategy: STRATEGY,
          seats: 1,
          sandboxUserId: DEMO_ADMIN.id,
        });

        await patch(eventId, naive, DEMO_ADMIN_TOKEN).expect(200);

        const detail = await get(`/api/events/${eventId}`, DEMO_ADMIN_TOKEN).expect(200);
        expect(EventDetailSchema.parse(detail.body).strategy).toBe(BOOKING_STRATEGY.NAIVE);
      });

      it("cannot switch another demo user's sandbox event: 404", async () => {
        const { eventId } = await createTestEvent(db, {
          strategy: STRATEGY,
          seats: 1,
          sandboxUserId: OTHER_DEMO_ADMIN.id,
        });

        await patch(eventId, naive, DEMO_ADMIN_TOKEN).expect(404);

        const detail = await get(`/api/events/${eventId}`, OTHER_DEMO_ADMIN_TOKEN).expect(200);
        expect(EventDetailSchema.parse(detail.body).strategy).toBe(STRATEGY);
      });
    });

    it('a regular admin switches public events but not a sandbox event: 404', async () => {
      const publicEvent = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });
      const sandbox = await createTestEvent(db, {
        strategy: STRATEGY,
        seats: 1,
        sandboxUserId: DEMO_ADMIN.id,
      });
      const body = { strategy: BOOKING_STRATEGY.NAIVE };

      await patch(publicEvent.eventId, body, ADMIN_TOKEN).expect(200);
      await patch(sandbox.eventId, body, ADMIN_TOKEN).expect(404);

      const detail = await get(`/api/events/${sandbox.eventId}`, DEMO_ADMIN_TOKEN).expect(200);
      expect(EventDetailSchema.parse(detail.body).strategy).toBe(STRATEGY);
    });

    it('answers 404 for an unknown event and 400 for a bad ID or strategy', async () => {
      const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });

      await patch(randomUUID(), { strategy: BOOKING_STRATEGY.NAIVE }, ADMIN_TOKEN).expect(404);
      await patch('not-a-uuid', { strategy: BOOKING_STRATEGY.NAIVE }, ADMIN_TOKEN).expect(400);
      await patch(eventId, { strategy: 'FAST' }, ADMIN_TOKEN).expect(400);
    });

    describe('when UNSAFE_STRATEGIES_ENABLED is false', () => {
      let guardedApp: INestApplication;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(APP_CONFIG)
          .useValue({ ...loadEnv(), UNSAFE_STRATEGIES_ENABLED: false })
          .overrideProvider(CLOCK)
          .useValue({ now: () => SPEC_NOW })
          .overrideProvider(TOKEN_VERIFIER)
          .useValue(fakeTokenVerifier({ [ADMIN_TOKEN]: ADMIN }))
          .compile();
        guardedApp = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
        await guardedApp.init();
      });
      afterAll(() => guardedApp.close());

      it('refuses switching to NAIVE with 400 and allows safe strategies', async () => {
        const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });

        await request(guardedApp.getHttpServer())
          .patch(`/api/events/${eventId}/strategy`)
          .set('X-Forwarded-For', randomClientAddress())
          .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
          .send({ strategy: BOOKING_STRATEGY.NAIVE })
          .expect(400);

        const unchanged = await get(`/api/events/${eventId}`).expect(200);
        expect(EventDetailSchema.parse(unchanged.body).strategy).toBe(STRATEGY);

        await request(guardedApp.getHttpServer())
          .patch(`/api/events/${eventId}/strategy`)
          .set('X-Forwarded-For', randomClientAddress())
          .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
          .send({ strategy: BOOKING_STRATEGY.OPTIMISTIC })
          .expect(200);
      });
    });
  });
});
