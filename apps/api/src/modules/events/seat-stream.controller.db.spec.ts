import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  BOOKING_STRATEGY,
  ROLE,
  SEAT_STATUS,
  SEAT_STREAM_EVENT,
  SeatChangeSchema,
  SeatSnapshotSchema,
} from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { openTestRedis } from '../../testing/redis.js';
import { TOKEN_VERIFIER } from '../auth/index.js';
import { seatChannel } from '../bookings/index.js';

const CUSTOMER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const STRANGER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const TOKENS = { customer: CUSTOMER, stranger: STRANGER };
type Caller = keyof typeof TOKENS;
const SHUTDOWN_LIMIT_MS = 5000;

interface ServerEvent {
  event: string;
  data: string;
}

/** Reads an SSE response block by block; comment-only blocks (the heartbeat) are skipped. */
async function openStream(app: INestApplication, path: string, caller?: Caller) {
  const { port } = app.getHttpServer().address() as AddressInfo; // SAFETY: listen() was called with a port
  const abort = new AbortController();
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/api${path}`, {
    signal: abort.signal,
    headers: {
      'X-Forwarded-For': randomClientAddress(),
      ...(caller === undefined ? {} : { Authorization: `Bearer ${caller}` }),
    },
  });
  const events: ServerEvent[] = [];
  const done = (async () => {
    if (response.body === null) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true }); // SAFETY: fetch bodies yield bytes
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const lines = block.split('\n').filter((line) => !line.startsWith(':'));
        const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
        const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length);
        if (event !== undefined && data !== undefined) events.push({ event, data });
      }
    }
  })().catch((error: Error) => {
    // The test aborts the read to end a stream; anything else is a real failure.
    if (error.name !== 'AbortError') throw error;
  });
  return { origin, response, events, abort: () => abort.abort(), done };
}

describe('GET /api/events/:id/seats/stream', () => {
  const database = openTestDatabase();
  const { db } = database;
  let app: INestApplication;
  let redis: Redis;

  const newApp = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier(TOKENS))
      .compile();
    const created = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await created.listen(0, '127.0.0.1');
    return created;
  };
  const subscribersOf = async (eventId: string): Promise<number> =>
    (await redis.pubSubNumSub(seatChannel(eventId)))[seatChannel(eventId)] ?? 0;
  const newEvent = (sandboxUserId?: string) =>
    createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 2,
      ...(sandboxUserId === undefined ? {} : { sandboxUserId }),
    });

  beforeAll(async () => {
    redis = await openTestRedis();
    app = await newApp();
  });
  afterAll(async () => {
    await app.close();
    await redis.quit();
    await database.close();
  });

  it('answers 404 for an unknown event and for another user’s sandbox event, 400 for a bad ID', async () => {
    const sandbox = await newEvent(CUSTOMER.id);

    for (const [path, caller] of [
      [`/events/${randomUUID()}/seats/stream`, undefined],
      [`/events/${sandbox.eventId}/seats/stream`, undefined],
      [`/events/${sandbox.eventId}/seats/stream`, 'stranger'],
    ] as const) {
      const stream = await openStream(app, path, caller);
      expect(stream.response.status).toBe(404);
      expect(stream.response.headers.get('content-type')).toContain('application/json');
    }
    expect((await openStream(app, '/events/not-a-uuid/seats/stream')).response.status).toBe(400);
  });

  it('streams a snapshot, then the change a hold causes, as text/event-stream', async () => {
    const { eventId, seatIds } = await newEvent();
    const stream = await openStream(app, `/events/${eventId}/seats/stream`);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
    await vi.waitFor(() => expect(stream.events).toHaveLength(1));

    const hold = await fetch(`${stream.origin}/api/bookings`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer customer',
        'Content-Type': 'application/json',
        'X-Forwarded-For': randomClientAddress(),
      },
      body: JSON.stringify({ eventId, seatId: seatIds[0] }),
    });
    expect(hold.status).toBe(201);

    await vi.waitFor(() => expect(stream.events).toHaveLength(2));
    const [snapshot, change] = stream.events;
    expect(snapshot?.event).toBe(SEAT_STREAM_EVENT.SNAPSHOT);
    expect(SeatSnapshotSchema.parse(JSON.parse(snapshot?.data ?? '')).seats).toHaveLength(2);
    expect(change?.event).toBe(SEAT_STREAM_EVENT.CHANGE);
    expect(SeatChangeSchema.parse(JSON.parse(change?.data ?? ''))).toMatchObject({
      eventId,
      seatId: seatIds[0],
      status: SEAT_STATUS.HELD,
    });
    stream.abort();
  });

  it('shows a sandbox event to its own user only', async () => {
    const { eventId } = await newEvent(CUSTOMER.id);

    const own = await openStream(app, `/events/${eventId}/seats/stream`, 'customer');

    expect(own.response.status).toBe(200);
    await vi.waitFor(() => expect(own.events).toHaveLength(1));
    own.abort();
  });

  it('stops listening to Redis when the client disconnects', async () => {
    const { eventId } = await newEvent();
    const stream = await openStream(app, `/events/${eventId}/seats/stream`);
    await vi.waitFor(() => expect(stream.events).toHaveLength(1));
    expect(await subscribersOf(eventId)).toBe(1);

    stream.abort();
    await stream.done;

    await vi.waitFor(async () => expect(await subscribersOf(eventId)).toBe(0));
  });
});

describe('seat stream on shutdown', () => {
  const database = openTestDatabase();
  afterAll(() => database.close());

  it('app.close() ends open streams and does not wait for the clients', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier(TOKENS))
      .compile();
    const app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.listen(0, '127.0.0.1');
    const { eventId } = await createTestEvent(database.db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const stream = await openStream(app, `/events/${eventId}/seats/stream`);
    await vi.waitFor(() => expect(stream.events).toHaveLength(1));

    const closed = await Promise.race([
      app.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_LIMIT_MS, 'hung')),
    ]);

    expect(closed).toBe('closed');
    await stream.done;
    stream.abort();
  });
});
