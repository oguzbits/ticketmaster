import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, ROLE, SEAT_STATUS, SEAT_STREAM_EVENT } from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { CLOCK } from '../../core/clock.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { openStream, originOf } from '../../testing/sse.js';
import { SPEC_NOW } from '../../testing/time.js';
import { TOKEN_VERIFIER } from '../auth/index.js';
import { SeatStreamService } from './seat-stream.service.js';

const CUSTOMER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };

/** Two API instances in one process that share the database and Redis, like two replicas. */
describe('two API instances', () => {
  const database = openTestDatabase();
  const { db } = database;
  const apps: INestApplication[] = [];

  const newApp = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue({ now: () => SPEC_NOW })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier({ customer: CUSTOMER }))
      .compile();
    const created = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await created.listen(0, '127.0.0.1');
    apps.push(created);
    return created;
  };
  let instanceA: INestApplication;
  let instanceB: INestApplication;

  beforeAll(async () => {
    instanceA = await newApp();
    instanceB = await newApp();
  });
  afterAll(async () => {
    for (const app of apps) await app.close();
    await database.close();
  });

  it('shows a hold made through instance A to a viewer connected to instance B', async () => {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const viewer = await openStream(instanceB, `/events/${eventId}/seats/stream`);
    await vi.waitFor(() => expect(viewer.events).toHaveLength(1));

    const hold = await fetch(`${originOf(instanceA)}/api/bookings`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer customer',
        'Content-Type': 'application/json',
        'X-Forwarded-For': randomClientAddress(),
      },
      body: JSON.stringify({ eventId, seatId: seatIds[0] }),
    });

    expect(hold.status).toBe(201);
    await vi.waitFor(() => expect(viewer.events).toHaveLength(2));
    expect(viewer.events[1]?.event).toBe(SEAT_STREAM_EVENT.CHANGE);
    expect(JSON.parse(viewer.events[1]?.data ?? '')).toMatchObject({
      seatId: seatIds[0],
      status: SEAT_STATUS.HELD,
    });
    viewer.abort();
  });

  it('counts the per-address stream cap over both instances', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const path = `/events/${eventId}/seats/stream`;
    for (const app of [instanceA, instanceB]) app.get(SeatStreamService).maxStreamsPerIp = 2;
    const address = randomClientAddress();
    const first = await openStream(instanceA, path, undefined, address);
    const second = await openStream(instanceA, path, undefined, address);

    const third = await openStream(instanceB, path, undefined, address);
    const elsewhere = await openStream(instanceB, path, undefined, randomClientAddress());

    expect([first, second].map(({ response }) => response.status)).toEqual([200, 200]);
    expect(third.response.status).toBe(429);
    expect(elsewhere.response.status).toBe(200);
    for (const stream of [first, second, elsewhere]) stream.abort();
  });
});
