import { randomUUID } from 'node:crypto';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  type BookingStatus,
  EventListResponseSchema,
  EventSummarySchema,
  OrganizerEventListResponseSchema,
  ROLE,
  VenueListResponseSchema,
} from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { CLOCK } from '../../core/clock.js';
import {
  bookings,
  demoUsers,
  events,
  seats,
  venues,
  venueSeats,
} from '../../infrastructure/database/schema.js';
import { RATE_LIMIT } from '../../infrastructure/rate-limit/rate-limit.decorator.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { SPEC_NOW } from '../../testing/time.js';
import { TOKEN_VERIFIER } from '../auth/index.js';
import { MAX_EVENTS_PER_OWNER } from './organizer.service.js';

const ORGANIZER_A = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const ORGANIZER_B = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const CUSTOMER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const DEMO_ORGANIZER = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const FULL_ORGANIZER = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const RACING_ORGANIZER = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const BURST_ORGANIZER = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const TOKENS = {
  a: ORGANIZER_A,
  b: ORGANIZER_B,
  customer: CUSTOMER,
  demo: DEMO_ORGANIZER,
  full: FULL_ORGANIZER,
  burst: BURST_ORGANIZER,
  racing: RACING_ORGANIZER,
};
type Caller = keyof typeof TOKENS;
const STRATEGY = BOOKING_STRATEGY.PESSIMISTIC;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_AFTER = new Date(SPEC_NOW.getTime() + DAY_MS).toISOString();
const DAY_BEFORE = new Date(SPEC_NOW.getTime() - DAY_MS).toISOString();

describe('organizer endpoints', () => {
  const database = openTestDatabase();
  const { db } = database;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier(TOKENS))
      .overrideProvider(CLOCK)
      .useValue({ now: () => SPEC_NOW })
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  const get = (path: string, caller?: Caller) => {
    const pending = request(app.getHttpServer())
      .get(`/api${path}`)
      .set('X-Forwarded-For', randomClientAddress());
    return caller === undefined ? pending : pending.set('Authorization', `Bearer ${caller}`);
  };

  const post = (path: string, body: object, caller?: Caller) => {
    const pending = request(app.getHttpServer())
      .post(`/api${path}`)
      .set('X-Forwarded-For', randomClientAddress())
      .send(body);
    return caller === undefined ? pending : pending.set('Authorization', `Bearer ${caller}`);
  };

  describe('access', () => {
    it.each(['/venues', '/organizer/events'])(
      'GET %s: no token is 401, a customer is 403',
      async (path) => {
        await get(path).expect(401);
        await get(path, 'customer').expect(403);
      }
    );

    it('POST /events: no token is 401, a customer is 403, and no event is created', async () => {
      const name = `denied ${randomUUID()}`;
      const body = { venueId: randomUUID(), name, startsAt: DAY_AFTER, strategy: STRATEGY };

      await post('/events', body).expect(401);
      await post('/events', body, 'customer').expect(403);

      expect(await db.select().from(events).where(eq(events.name, name))).toEqual([]);
    });
  });

  describe('venues', () => {
    it('lists the venues with their seat count', async () => {
      const venueId = randomUUID();
      await db.insert(venues).values({ id: venueId, name: `venue ${venueId}` });
      await db.insert(venueSeats).values([
        { venueId, section: 'A', row: 1, number: 1 },
        { venueId, section: 'A', row: 1, number: 2 },
        { venueId, section: 'B', row: 1, number: 1 },
      ]);

      const response = await get('/venues', 'a').expect(200);

      const listed = VenueListResponseSchema.parse(response.body);
      expect(listed.find(({ id }) => id === venueId)).toEqual({
        id: venueId,
        name: `venue ${venueId}`,
        seatCount: 3,
      });
    });
  });

  describe('create event', () => {
    const PRICED = [
      { section: 'A', row: 1, number: 1, priceCents: 9000 },
      { section: 'A', row: 1, number: 2, priceCents: 9000 },
      { section: 'B', row: 1, number: 1, priceCents: 4000 },
    ];
    async function venueWith(
      template: { section: string; row: number; number: number; priceCents: number | null }[]
    ) {
      const venueId = randomUUID();
      await db.insert(venues).values({ id: venueId, name: `venue ${venueId}` });
      await db.insert(venueSeats).values(template.map((seat) => ({ venueId, ...seat })));
      return venueId;
    }
    const create = (venueId: string, caller: Caller, extra: object = {}) =>
      post(
        '/events',
        {
          venueId,
          name: `Gala ${randomUUID()}`,
          startsAt: DAY_AFTER,
          strategy: STRATEGY,
          ...extra,
        },
        caller
      );

    it('copies every seat of the venue with the price of its section', async () => {
      const venueId = await venueWith(PRICED);

      const response = await create(venueId, 'a', { name: 'Gala' }).expect(201);

      const created = EventSummarySchema.parse(response.body);
      expect(created).toMatchObject({ name: 'Gala', startsAt: DAY_AFTER, strategy: STRATEGY });
      const copied = await db.select().from(seats).where(eq(seats.eventId, created.id));
      expect(
        copied
          .map(({ section, row, number, priceCents }) => ({ section, row, number, priceCents }))
          .toSorted((x, y) => x.section.localeCompare(y.section) || x.number - y.number)
      ).toEqual(PRICED);
    });

    it('owns the event by the caller from the token and publishes it, so a visitor sees it', async () => {
      const venueId = await venueWith(PRICED);

      const { body } = await create(venueId, 'a').expect(201);

      const [stored] = await db
        .select()
        .from(events)
        .where(eq(events.id, EventSummarySchema.parse(body).id));
      expect(stored).toMatchObject({ ownerId: ORGANIZER_A.id, sandboxUserId: null });
      const listed = await request(app.getHttpServer())
        .get('/api/events')
        .set('X-Forwarded-For', randomClientAddress())
        .expect(200);
      expect(EventListResponseSchema.parse(listed.body).map(({ id }) => id)).toContain(stored?.id);
    });

    it('keeps an event of a demo user private to that user', async () => {
      await db
        .insert(demoUsers)
        .values({ userId: DEMO_ORGANIZER.id, role: ROLE.ORGANIZER, expiresAt: SPEC_NOW });
      const venueId = await venueWith(PRICED);

      const { body } = await create(venueId, 'demo').expect(201);

      const { id } = EventSummarySchema.parse(body);
      const [stored] = await db.select().from(events).where(eq(events.id, id));
      expect(stored).toMatchObject({
        ownerId: DEMO_ORGANIZER.id,
        sandboxUserId: DEMO_ORGANIZER.id,
      });
      await request(app.getHttpServer())
        .get(`/api/events/${id}`)
        .set('X-Forwarded-For', randomClientAddress())
        .expect(404);
    });

    it('answers 429 after CREATE_EVENT.limit creations from one address', async () => {
      const venueId = await venueWith(PRICED);
      const address = randomClientAddress();
      const createFrom = () =>
        post(
          '/events',
          { venueId, name: 'Burst', startsAt: DAY_AFTER, strategy: STRATEGY },
          'burst'
        ).set('X-Forwarded-For', address);

      for (let call = 0; call < RATE_LIMIT.CREATE_EVENT.limit; call++) {
        await createFrom().expect(201);
      }
      const refused = await createFrom().expect(429);

      expect(refused.headers['retry-after']).toBeDefined();
    });

    describe('the cap of MAX_EVENTS_PER_OWNER events per owner', () => {
      const own = (count: number) =>
        Promise.all(
          Array.from({ length: count }, () =>
            createTestEvent(db, { strategy: STRATEGY, seats: 0, ownerId: FULL_ORGANIZER.id })
          )
        );

      it('allows the last event under the cap and answers 409 for the next, nothing is stored', async () => {
        const venueId = await venueWith(PRICED);
        await own(MAX_EVENTS_PER_OWNER - 1);
        const name = `over the cap ${randomUUID()}`;

        await create(venueId, 'full').expect(201);
        const refused = await create(venueId, 'full', { name }).expect(409);

        expect(refused.body).toMatchObject({ message: expect.stringContaining('20') });
        expect(await db.select().from(events).where(eq(events.name, name))).toEqual([]);
      });

      it('another owner is not affected', async () => {
        const venueId = await venueWith(PRICED);

        await create(venueId, 'b').expect(201);
      });
    });

    it('parallel creations cannot pass the cap together', async () => {
      const venueId = await venueWith(PRICED);
      await Promise.all(
        Array.from({ length: MAX_EVENTS_PER_OWNER - 1 }, () =>
          createTestEvent(db, { strategy: STRATEGY, seats: 0, ownerId: RACING_ORGANIZER.id })
        )
      );

      const answers = await Promise.all(Array.from({ length: 5 }, () => create(venueId, 'racing')));

      expect(answers.filter(({ status }) => status === 201)).toHaveLength(1);
      expect(answers.filter(({ status }) => status === 409)).toHaveLength(4);
    });

    it('answers 404 for an unknown venue and 400 for a start in the past or a bad body', async () => {
      const venueId = await venueWith(PRICED);

      await create(randomUUID(), 'a').expect(404);
      await create(venueId, 'a', { startsAt: DAY_BEFORE }).expect(400);
      await create(venueId, 'a', { startsAt: new Date(SPEC_NOW).toISOString() }).expect(400);
      await create(venueId, 'a', { name: '  ' }).expect(400);
      await create(venueId, 'a', { strategy: 'FAST' }).expect(400);
      await create('not-a-uuid', 'a').expect(400);
    });

    it('creates the event and its seats in one transaction: a seat without a price leaves nothing behind', async () => {
      const venueId = await venueWith([
        ...PRICED,
        { section: 'C', row: 1, number: 1, priceCents: null },
      ]);
      const name = `half ${randomUUID()}`;

      await create(venueId, 'a', { name }).expect(500);

      expect(await db.select().from(events).where(eq(events.name, name))).toEqual([]);
    });
  });

  describe('own events', () => {
    const ownEvents = async (caller: Caller) =>
      OrganizerEventListResponseSchema.parse(
        (await get('/organizer/events', caller).expect(200)).body
      );

    it('lists only the events the caller owns', async () => {
      const mine = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 1,
        ownerId: ORGANIZER_A.id,
      });
      const theirs = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 1,
        ownerId: ORGANIZER_B.id,
      });

      const ids = (await ownEvents('a')).map(({ id }) => id);

      expect(ids).toContain(mine.eventId);
      expect(ids).not.toContain(theirs.eventId);
    });

    it('counts sold and held seats from the bookings, not expired or cancelled ones', async () => {
      const { eventId, seatIds } = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 6,
        ownerId: ORGANIZER_A.id,
      });
      const statuses: BookingStatus[] = [
        BOOKING_STATUS.HELD,
        BOOKING_STATUS.HELD,
        BOOKING_STATUS.CONFIRMED,
        BOOKING_STATUS.EXPIRED,
        BOOKING_STATUS.CANCELLED,
      ];
      await db.insert(bookings).values(
        statuses.map((status, index) => ({
          eventId,
          seatId: seatIds[index] ?? '',
          userId: CUSTOMER.id,
          strategy: BOOKING_STRATEGY.PESSIMISTIC,
          status,
          holdExpiresAt: SPEC_NOW,
        }))
      );

      const event = (await ownEvents('a')).find(({ id }) => id === eventId);

      expect(event).toMatchObject({ seatCount: 6, soldCount: 1, heldCount: 2 });
      expect(event?.utilization).toBeCloseTo(1 / 6);
    });

    it('reports an event without seats as 0 utilization', async () => {
      const { eventId } = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 0,
        ownerId: ORGANIZER_A.id,
      });

      const event = (await ownEvents('a')).find(({ id }) => id === eventId);

      expect(event).toMatchObject({ seatCount: 0, utilization: 0 });
    });
  });
});
