import { randomUUID } from 'node:crypto';

import {
  BOOKING_STRATEGY,
  EventSummarySchema,
  ROLE,
  WAITING_ROOM_STATE,
  WaitingRoomStatusSchema,
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
import { events } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { lockSpecs } from '../../testing/spec-lock.js';
import { SPEC_NOW } from '../../testing/time.js';
import { TOKEN_VERIFIER } from '../auth/index.js';

// Every call is a millisecond later: users who join in a row keep the order they joined in.
let tick = 0;
const ADVANCING_CLOCK = { now: () => new Date(SPEC_NOW.getTime() + tick++) };

const TOKENS = {
  one: { id: randomUUID(), roles: [ROLE.CUSTOMER] },
  two: { id: randomUUID(), roles: [ROLE.CUSTOMER] },
  organizer: { id: randomUUID(), roles: [ROLE.ORGANIZER] },
  other: { id: randomUUID(), roles: [ROLE.ORGANIZER] },
  admin: { id: randomUUID(), roles: [ROLE.ADMIN] },
};
type Caller = keyof typeof TOKENS;
const CAPACITY = 5;

describe('waiting room endpoints', () => {
  const database = openTestDatabase();
  const { db } = database;
  let app: INestApplication;
  let unlock: () => Promise<void>;

  beforeAll(async () => {
    // Another file's admitDue would admit the users queued here.
    unlock = await lockSpecs(db, 'waiting-room');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier(TOKENS))
      .overrideProvider(CLOCK)
      .useValue(ADVANCING_CLOCK)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await unlock();
    await database.close();
  });

  const send = (method: 'get' | 'post' | 'put' | 'delete', path: string, caller?: Caller) => {
    const call = request(app.getHttpServer())[method](`/api${path}`);
    const pending = call.set('X-Forwarded-For', randomClientAddress());
    return caller === undefined ? pending : pending.set('Authorization', `Bearer ${caller}`);
  };
  const newEvent = (extra: { sandboxUserId?: string; ownerId?: string } = {}) =>
    createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 0,
      waitingRoomCapacity: CAPACITY,
      ...extra,
    }).then(({ eventId }) => eventId);
  const status = async (eventId: string, caller: Caller) =>
    WaitingRoomStatusSchema.parse(
      (await send('get', `/events/${eventId}/waiting-room`, caller)).body
    );

  it('a customer joins and sees position 1', async () => {
    const eventId = await newEvent();

    const response = await send('post', `/events/${eventId}/waiting-room`, 'one').expect(200);

    expect(WaitingRoomStatusSchema.parse(response.body)).toMatchObject({
      state: WAITING_ROOM_STATE.WAITING,
      position: 1,
      waiting: 1,
    });
  });

  it('a second customer sees position 2', async () => {
    const eventId = await newEvent();
    await send('post', `/events/${eventId}/waiting-room`, 'one').expect(200);

    const response = await send('post', `/events/${eventId}/waiting-room`, 'two').expect(200);

    expect(WaitingRoomStatusSchema.parse(response.body)).toMatchObject({ position: 2, waiting: 2 });
  });

  it('joining twice keeps one place', async () => {
    const eventId = await newEvent();
    await send('post', `/events/${eventId}/waiting-room`, 'one').expect(200);
    await send('post', `/events/${eventId}/waiting-room`, 'two').expect(200);

    await send('post', `/events/${eventId}/waiting-room`, 'one').expect(200);

    expect(await status(eventId, 'one')).toMatchObject({ position: 1, waiting: 2 });
  });

  it('join answers 409 for an event without a waiting room', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 0,
    });

    await send('post', `/events/${eventId}/waiting-room`, 'one').expect(409);
  });

  it('join answers 404 for a foreign sandbox event', async () => {
    const eventId = await newEvent({ sandboxUserId: randomUUID() });

    await send('post', `/events/${eventId}/waiting-room`, 'one').expect(404);
    expect(await status(eventId, 'one')).toMatchObject({ state: WAITING_ROOM_STATE.NONE });
  });

  it('an organizer joining answers 403', async () => {
    const eventId = await newEvent();

    await send('post', `/events/${eventId}/waiting-room`, 'organizer').expect(403);
  });

  it('leave frees the place', async () => {
    const eventId = await newEvent();
    await send('post', `/events/${eventId}/waiting-room`, 'one').expect(200);
    await send('post', `/events/${eventId}/waiting-room`, 'two').expect(200);

    await send('delete', `/events/${eventId}/waiting-room`, 'one').expect(204);

    expect(await status(eventId, 'one')).toMatchObject({ state: WAITING_ROOM_STATE.NONE });
    expect(await status(eventId, 'two')).toMatchObject({ position: 1, waiting: 1 });
  });

  it('GET status of a user who never joined is NONE', async () => {
    const eventId = await newEvent();

    expect(await status(eventId, 'one')).toEqual({
      state: WAITING_ROOM_STATE.NONE,
      position: null,
      waiting: 0,
      admittedUntil: null,
    });
  });

  describe('settings', () => {
    const put = (eventId: string, capacity: number | null, caller?: Caller) =>
      send('put', `/events/${eventId}/waiting-room/settings`, caller).send({ capacity });

    it('the organizer of the event sets and clears the capacity', async () => {
      const eventId = await newEvent({ ownerId: TOKENS.organizer.id });

      const set = await put(eventId, 7, 'organizer').expect(200);
      expect(EventSummarySchema.parse(set.body).waitingRoomCapacity).toBe(7);

      const cleared = await put(eventId, null, 'organizer').expect(200);
      expect(EventSummarySchema.parse(cleared.body).waitingRoomCapacity).toBeNull();
      const [row] = await db.select().from(events).where(eq(events.id, eventId));
      expect(row?.waitingRoomCapacity).toBeNull();
    });

    it('an admin sets the capacity of a public event', async () => {
      const eventId = await newEvent({ ownerId: TOKENS.organizer.id });

      await put(eventId, 9, 'admin').expect(200);
    });

    it('a customer answers 403 and nothing changes', async () => {
      const eventId = await newEvent({ ownerId: TOKENS.organizer.id });

      await put(eventId, 9, 'one').expect(403);

      const [row] = await db.select().from(events).where(eq(events.id, eventId));
      expect(row?.waitingRoomCapacity).toBe(CAPACITY);
    });

    it("another organizer's event answers 404 and nothing changes", async () => {
      const eventId = await newEvent({ ownerId: TOKENS.organizer.id });

      await put(eventId, 9, 'other').expect(404);

      const [row] = await db.select().from(events).where(eq(events.id, eventId));
      expect(row?.waitingRoomCapacity).toBe(CAPACITY);
    });

    it('an unauthenticated call answers 401', async () => {
      const eventId = await newEvent();

      await put(eventId, 9).expect(401);
    });
  });
});
