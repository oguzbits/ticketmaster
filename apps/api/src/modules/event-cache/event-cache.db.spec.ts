import { randomUUID } from 'node:crypto';

import {
  BOOKING_STRATEGY,
  EventDetailSchema,
  EventListResponseSchema,
  ROLE,
  SEAT_STATUS,
} from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createNoopMeter } from '@opentelemetry/api';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { APP_CONFIG, loadEnv } from '../../config/config.module.js';
import { CLOCK } from '../../core/clock.js';
import { venues } from '../../infrastructure/database/schema.js';
import { subscribeQueryCounter } from '../../infrastructure/metrics/query-counter.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import { TOKEN_VERIFIER } from '../auth/index.js';
import { LIST_KEY } from './event-cache.js';

const OWNER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const OTHER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const ADMIN = { id: randomUUID(), roles: [ROLE.ADMIN] };
const ORGANIZER = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const TOKENS = { owner: OWNER, other: OTHER, admin: ADMIN, organizer: ORGANIZER };
type Caller = keyof typeof TOKENS;
const STRATEGY = BOOKING_STRATEGY.PESSIMISTIC;
const TTL_SECONDS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Counts the queries that start, through the adapter the app uses for its in-flight gauge. */
function countQueries() {
  let started = 0;
  const meter = Object.assign(createNoopMeter(), {
    createUpDownCounter: () => ({
      add: (value: number) => {
        if (value > 0) started += value;
      },
    }),
  });
  const stop = subscribeQueryCounter(meter);
  return { stop, started: () => started };
}

/**
 * The only spec file that runs with the event cache on (the db project sets the TTL to 0), so the
 * shared keys are its own.
 */
describe('event cache', () => {
  const database = openTestDatabase();
  const { db } = database;
  let app: INestApplication;
  let redis: Redis;

  beforeAll(async () => {
    redis = await openTestRedis();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue({ now: () => SPEC_NOW })
      .overrideProvider(APP_CONFIG)
      .useValue({ ...loadEnv(), EVENT_CACHE_TTL_SECONDS: TTL_SECONDS })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier(TOKENS))
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });
  beforeEach(async () => {
    await redis.del(LIST_KEY);
  });
  afterAll(async () => {
    await app.close();
    await redis.quit();
    await database.close();
  });

  const send = (method: 'get' | 'post' | 'put' | 'patch', path: string, caller?: Caller) => {
    const server = request(app.getHttpServer());
    const call = server[method](path).set('X-Forwarded-For', randomClientAddress());
    return caller === undefined ? call : call.set('Authorization', `Bearer ${caller}`);
  };
  const listed = async (caller?: Caller) =>
    EventListResponseSchema.parse((await send('get', '/api/events', caller).expect(200)).body);
  const detailOf = async (eventId: string, caller?: Caller) =>
    EventDetailSchema.parse((await send('get', `/api/events/${eventId}`, caller).expect(200)).body);
  const newEvent = (seats = 1, extra: { ownerId?: string; waitingRoomCapacity?: number } = {}) =>
    createTestEvent(db, { strategy: STRATEGY, seats, ...extra });

  it('second list request runs no event query', async () => {
    await listed();
    const queries = countQueries();

    await listed();

    queries.stop();
    expect(queries.started()).toBe(0);
  });

  it('second detail request runs only the status query', async () => {
    const { eventId } = await newEvent();
    await detailOf(eventId);
    const queries = countQueries();

    await detailOf(eventId);

    queries.stop();
    expect(queries.started()).toBe(1);
  });

  it('a hold shows in the next detail within the TTL', async () => {
    const { eventId, seatIds } = await newEvent(2);
    const [seatId] = seatIds;
    await detailOf(eventId);

    await send('post', '/api/bookings', 'other').send({ eventId, seatId }).expect(201);

    const detail = await detailOf(eventId);
    expect(detail.seats.find((seat) => seat.id === seatId)?.status).toBe(SEAT_STATUS.HELD);
    expect(detail.seats.filter((seat) => seat.status === SEAT_STATUS.AVAILABLE)).toHaveLength(1);
  });

  it('strategy switch shows in the list and the detail at once', async () => {
    const { eventId } = await newEvent();
    await listed();
    await detailOf(eventId);

    await send('patch', `/api/events/${eventId}/strategy`, 'admin')
      .send({ strategy: BOOKING_STRATEGY.OPTIMISTIC })
      .expect(200);

    expect((await listed()).find(({ id }) => id === eventId)?.strategy).toBe(
      BOOKING_STRATEGY.OPTIMISTIC
    );
    expect((await detailOf(eventId)).strategy).toBe(BOOKING_STRATEGY.OPTIMISTIC);
  });

  it('waiting room capacity change shows in the list at once', async () => {
    const { eventId } = await newEvent(1, { ownerId: ORGANIZER.id });
    await listed();

    await send('put', `/api/events/${eventId}/waiting-room/settings`, 'organizer')
      .send({ capacity: 7 })
      .expect(200);

    expect((await listed()).find(({ id }) => id === eventId)?.waitingRoomCapacity).toBe(7);
  });

  it('a new public event shows in the list at once', async () => {
    const venueId = randomUUID();
    await db.insert(venues).values({ id: venueId, name: `cache venue ${venueId}` });
    await listed();

    const created = await send('post', '/api/events', 'organizer')
      .send({
        venueId,
        name: 'Fresh event',
        startsAt: new Date(SPEC_NOW.getTime() + DAY_MS).toISOString(),
        strategy: STRATEGY,
      })
      .expect(201);

    const ids = (await listed()).map(({ id }) => id);
    expect(ids).toContain(created.body.id);
  });

  it('a sandbox event is served only to its owner, from the database', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: STRATEGY,
      seats: 1,
      sandboxUserId: OWNER.id,
    });

    expect((await listed('owner')).map(({ id }) => id)).toContain(eventId);
    await detailOf(eventId, 'owner');

    expect((await listed()).map(({ id }) => id)).not.toContain(eventId);
    expect((await listed('other')).map(({ id }) => id)).not.toContain(eventId);
    await send('get', `/api/events/${eventId}`).expect(404);
    await send('get', `/api/events/${eventId}`, 'other').expect(404);
    const keys = await redis.keys('events:*');
    expect(keys.filter((key) => key.includes(eventId))).toEqual([]);
    expect((await listed('owner')).map(({ id }) => id)).toContain(eventId);
  });
});
