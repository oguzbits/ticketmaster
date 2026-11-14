import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, ROLE, WaitingRoomStatusSchema } from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { CLOCK } from '../../core/clock.js';
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
};

/** Two API instances in one process that share the database and Redis, like two replicas. */
describe('two API instances', () => {
  const database = openTestDatabase();
  const { db } = database;
  const apps: INestApplication[] = [];
  let unlock: () => Promise<void>;

  const newApp = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(ADVANCING_CLOCK)
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier(TOKENS))
      .compile();
    const created = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await created.init();
    apps.push(created);
    return created;
  };
  let instanceA: INestApplication;
  let instanceB: INestApplication;

  beforeAll(async () => {
    unlock = await lockSpecs(db, 'waiting-room');
    instanceA = await newApp();
    instanceB = await newApp();
  });
  afterAll(async () => {
    for (const app of apps) await app.close();
    await unlock();
    await database.close();
  });

  const send = async (
    app: INestApplication,
    method: 'get' | 'post',
    path: string,
    token: string
  ) => {
    const call = request(app.getHttpServer())[method](`/api${path}`);
    const { body } = await call
      .set('X-Forwarded-For', randomClientAddress())
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return WaitingRoomStatusSchema.parse(body);
  };

  it('both instances show the same position and a join on A is seen on B', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 0,
      waitingRoomCapacity: 5,
    });
    const path = `/events/${eventId}/waiting-room`;

    await send(instanceA, 'post', path, 'one');
    const joinedOnB = await send(instanceB, 'post', path, 'two');

    expect(joinedOnB).toMatchObject({ position: 2, waiting: 2 });
    expect(await send(instanceA, 'get', path, 'two')).toEqual(joinedOnB);
    expect(await send(instanceB, 'get', path, 'one')).toMatchObject({ position: 1, waiting: 2 });
  });
});
