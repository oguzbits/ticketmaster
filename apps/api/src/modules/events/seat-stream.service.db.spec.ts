import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, SEAT_STATUS, SEAT_STREAM_EVENT, type SeatChange } from '@app/shared';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { seatChannel } from '../bookings/index.js';
import { EventsService } from './events.service.js';
import { HEARTBEAT_MS, type SeatStreamMessage, SeatStreamService } from './seat-stream.service.js';

describe('SeatStreamService', () => {
  const database = openTestDatabase();
  const { db } = database;
  const events = new EventsService(db);
  let redis: Redis;
  let snapshotGate: Promise<void> = Promise.resolve();
  let service: SeatStreamService;
  const open: Subscription[] = [];

  beforeAll(async () => {
    redis = await openTestRedis();
    // The gate lets a spec hold the snapshot read back while it publishes.
    service = new SeatStreamService(redis, {
      detail: async (id, userId) => {
        await snapshotGate;
        return events.detail(id, userId);
      },
    });
    await service.onModuleInit();
  });
  afterEach(() => {
    for (const subscription of open.splice(0)) subscription.unsubscribe();
    snapshotGate = Promise.resolve();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await service.onModuleDestroy();
    await redis.quit();
    await database.close();
  });

  /** Subscribes like the SSE route does and records what arrives. */
  function listen(eventId: string, userId: string | null = null) {
    const messages: SeatStreamMessage[] = [];
    const state: { error?: Error; completed: boolean } = { completed: false };
    const subscription = service.stream(eventId, userId).subscribe({
      next: (message) => messages.push(message),
      error: (error: Error) => (state.error = error),
      complete: () => (state.completed = true),
    });
    open.push(subscription);
    return { messages, state, subscription };
  }

  /** Publishes like the booking service does: JSON on the event's channel. */
  const publish = (change: SeatChange): Promise<number> =>
    redis.publish(seatChannel(change.eventId), JSON.stringify(change));
  const change = (
    eventId: string,
    seatId: string,
    status: SeatChange['status'] = SEAT_STATUS.HELD
  ): SeatChange => ({
    eventId,
    seatId,
    status,
    at: new Date().toISOString(),
  });
  const subscribersOf = async (eventId: string): Promise<number> =>
    (await redis.pubSubNumSub(seatChannel(eventId)))[seatChannel(eventId)] ?? 0;
  const newEvent = (seats = 2) =>
    createTestEvent(db, { strategy: BOOKING_STRATEGY.PESSIMISTIC, seats });

  it('sends the snapshot first and every later change after it', async () => {
    const { eventId, seatIds } = await newEvent();
    const viewer = listen(eventId);
    await vi.waitFor(() => expect(viewer.messages).toHaveLength(1));

    await publish(change(eventId, seatIds[0] ?? ''));

    await vi.waitFor(() => expect(viewer.messages).toHaveLength(2));
    expect(viewer.messages[0]).toMatchObject({
      type: SEAT_STREAM_EVENT.SNAPSHOT,
      data: { seats: [{ id: seatIds[0] }, { id: seatIds[1] }] },
    });
    expect(viewer.messages[1]).toEqual({
      type: SEAT_STREAM_EVENT.CHANGE,
      data: expect.objectContaining({ seatId: seatIds[0], status: SEAT_STATUS.HELD }),
    });
  });

  it('a change published while the snapshot is still being read comes after the snapshot', async () => {
    const { eventId, seatIds } = await newEvent();
    let release: () => void = () => undefined;
    snapshotGate = new Promise((resolve) => (release = resolve));
    const viewer = listen(eventId);
    // The viewer's Redis subscription is up while the snapshot read waits.
    await vi.waitFor(async () => expect(await subscribersOf(eventId)).toBe(1));

    await publish(change(eventId, seatIds[0] ?? ''));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();

    await vi.waitFor(() => expect(viewer.messages).toHaveLength(2));
    expect(
      viewer.messages.map((message) => ('type' in message ? message.type : 'comment'))
    ).toEqual([SEAT_STREAM_EVENT.SNAPSHOT, SEAT_STREAM_EVENT.CHANGE]);
  });

  it('gives a change to every viewer of the event and to no viewer of another event', async () => {
    const first = await newEvent();
    const other = await newEvent();
    const [a, b, elsewhere] = [listen(first.eventId), listen(first.eventId), listen(other.eventId)];
    await vi.waitFor(() => expect(elsewhere.messages).toHaveLength(1));
    await vi.waitFor(() => expect(b.messages).toHaveLength(1));

    await publish(change(first.eventId, first.seatIds[0] ?? ''));
    await publish(change(other.eventId, other.seatIds[1] ?? '', SEAT_STATUS.SOLD));

    await vi.waitFor(() => {
      expect(a.messages).toHaveLength(2);
      expect(b.messages).toHaveLength(2);
      expect(elsewhere.messages).toHaveLength(2);
    });
    expect(elsewhere.messages[1]).toMatchObject({ data: { eventId: other.eventId } });
    expect(a.messages[1]).toMatchObject({ data: { eventId: first.eventId } });
  });

  it('drops the Redis subscription when the last viewer of the event leaves', async () => {
    const { eventId } = await newEvent();
    const [a, b] = [listen(eventId), listen(eventId)];
    await vi.waitFor(() => expect(b.messages).toHaveLength(1));
    expect(await subscribersOf(eventId)).toBe(1);

    a.subscription.unsubscribe();
    // One viewer is left, so the event stays subscribed.
    expect(await subscribersOf(eventId)).toBe(1);
    b.subscription.unsubscribe();

    await vi.waitFor(async () => expect(await subscribersOf(eventId)).toBe(0));
  });

  it('fails with NotFound for an event the viewer may not see, and leaves nothing subscribed', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
      sandboxUserId: randomUUID(),
    });

    const stranger = listen(eventId, randomUUID());

    await vi.waitFor(() => expect(stranger.state.error).toBeInstanceOf(NotFoundException));
    await vi.waitFor(async () => expect(await subscribersOf(eventId)).toBe(0));
  });

  it('skips a malformed message, logs it and keeps streaming', async () => {
    const { eventId, seatIds } = await newEvent();
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const viewer = listen(eventId);
    await vi.waitFor(() => expect(viewer.messages).toHaveLength(1));

    await redis.publish(seatChannel(eventId), 'not json');
    await redis.publish(seatChannel(eventId), JSON.stringify({ eventId }));
    await publish(change(eventId, seatIds[0] ?? ''));

    await vi.waitFor(() => expect(viewer.messages).toHaveLength(2));
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it('sends a heartbeat comment at the interval, every 15 seconds by default', async () => {
    const { eventId } = await newEvent();
    expect(service.heartbeatMs).toBe(HEARTBEAT_MS);
    expect(HEARTBEAT_MS).toBe(15_000);
    service.heartbeatMs = 20;

    try {
      const viewer = listen(eventId);
      await vi.waitFor(() =>
        expect(viewer.messages.filter((message) => 'comment' in message)).toHaveLength(2)
      );
      expect(viewer.messages.find((message) => 'comment' in message)).toEqual({
        comment: 'heartbeat',
      });
    } finally {
      service.heartbeatMs = HEARTBEAT_MS;
    }
  });
});

describe('SeatStreamService shutdown', () => {
  const database = openTestDatabase();
  afterAll(() => database.close());

  it('completes the open streams and closes its Redis connection', async () => {
    const redis = await openTestRedis();
    const service = new SeatStreamService(redis, new EventsService(database.db));
    await service.onModuleInit();
    const { eventId } = await createTestEvent(database.db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const messages: SeatStreamMessage[] = [];
    let completed = false;
    service.stream(eventId, null).subscribe({
      next: (message) => messages.push(message),
      complete: () => (completed = true),
    });
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    await service.onModuleDestroy();

    expect(completed).toBe(true);
    expect((await redis.pubSubNumSub(seatChannel(eventId)))[seatChannel(eventId)]).toBe(0);
    await redis.quit();
  });
});
