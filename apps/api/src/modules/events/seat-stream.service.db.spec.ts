import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, SEAT_STATUS, SEAT_STREAM_EVENT, type SeatChange } from '@app/shared';
import { HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SystemClock } from '../../infrastructure/clock/system-clock.js';
import { SlotLimiter } from '../../infrastructure/rate-limit/slot-limiter.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { seatChannel } from '../bookings/index.js';
import { EventsService } from './events.service.js';
import {
  HEARTBEAT_MS,
  MAX_STREAMS_PER_IP,
  MAX_STREAMS_TOTAL,
  type SeatStreamMessage,
  SeatStreamService,
  STREAM_MAX_LIFETIME_MS,
} from './seat-stream.service.js';

const slotsOf = (redis: Redis) => new SlotLimiter(redis, new SystemClock());
/** Counters of their own: the default keys are shared with every other spec and the dev stack. */
const ownSlotKeys = (service: SeatStreamService) => {
  service.slotKeyPrefix = `streams:test:${randomUUID()}`;
  return service;
};
const ADDRESS = '10.0.0.1';
const OTHER_ADDRESS = '10.0.0.2';

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
    service = ownSlotKeys(
      new SeatStreamService(
        redis,
        {
          detail: async (id, userId) => {
            await snapshotGate;
            return events.detail(id, userId);
          },
        },
        slotsOf(redis)
      )
    );
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
  async function listen(eventId: string, userId: string | null = null, address = ADDRESS) {
    const messages: SeatStreamMessage[] = [];
    const state: { error?: Error; completed: boolean } = { completed: false };
    const subscription = (await service.stream(eventId, userId, address)).subscribe({
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
    const viewer = await listen(eventId);
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
    const viewer = await listen(eventId);
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
    const [a, b, elsewhere] = await Promise.all([
      listen(first.eventId),
      listen(first.eventId),
      listen(other.eventId),
    ]);
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
    const [a, b] = await Promise.all([listen(eventId), listen(eventId)]);
    await vi.waitFor(() => expect(b.messages).toHaveLength(1));
    expect(await subscribersOf(eventId)).toBe(1);

    a.subscription.unsubscribe();
    // One viewer is left, so the event stays subscribed.
    expect(await subscribersOf(eventId)).toBe(1);
    b.subscription.unsubscribe();

    await vi.waitFor(async () => expect(await subscribersOf(eventId)).toBe(0));
  });

  it('a viewer who joins right after the last one left still gets the changes', async () => {
    const { eventId, seatIds } = await newEvent();
    const first = await listen(eventId);
    await vi.waitFor(() => expect(first.messages).toHaveLength(1));

    first.subscription.unsubscribe();
    const second = await listen(eventId);
    await vi.waitFor(() => expect(second.messages).toHaveLength(1));
    await publish(change(eventId, seatIds[0] ?? ''));

    await vi.waitFor(() => expect(second.messages).toHaveLength(2));
  });

  it('leaves nothing subscribed when a viewer joins and leaves right after the last one left', async () => {
    const { eventId } = await newEvent();
    const first = await listen(eventId);
    await vi.waitFor(() => expect(first.messages).toHaveLength(1));
    first.subscription.unsubscribe();
    const second = await listen(eventId);
    second.subscription.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await subscribersOf(eventId)).toBe(0);
  });

  it('fails with NotFound for an event the viewer may not see, and leaves nothing subscribed', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
      sandboxUserId: randomUUID(),
    });

    const stranger = await listen(eventId, randomUUID());

    await vi.waitFor(() => expect(stranger.state.error).toBeInstanceOf(NotFoundException));
    await vi.waitFor(async () => expect(await subscribersOf(eventId)).toBe(0));
  });

  it('skips a malformed message, logs it and keeps streaming', async () => {
    const { eventId, seatIds } = await newEvent();
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const viewer = await listen(eventId);
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
      const viewer = await listen(eventId);
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

describe('SeatStreamService limits', () => {
  const database = openTestDatabase();
  const { db } = database;
  let redis: Redis;
  // Two API instances that share one Redis, like two replicas.
  let service: SeatStreamService;
  let other: SeatStreamService;
  const open: Subscription[] = [];
  // Its own counters: the default keys are shared with every other spec and the dev stack.
  const keyPrefix = `streams:test:${randomUUID()}`;
  const services = () => [service, other];

  beforeAll(async () => {
    redis = await openTestRedis();
    service = new SeatStreamService(redis, new EventsService(db), slotsOf(redis));
    other = new SeatStreamService(redis, new EventsService(db), slotsOf(redis));
    for (const instance of services()) {
      instance.slotKeyPrefix = keyPrefix;
      await instance.onModuleInit();
    }
  });
  afterEach(async () => {
    for (const subscription of open.splice(0)) subscription.unsubscribe();
    for (const instance of services()) {
      instance.maxStreamsPerIp = MAX_STREAMS_PER_IP;
      instance.maxStreamsTotal = MAX_STREAMS_TOTAL;
      instance.maxLifetimeMs = STREAM_MAX_LIFETIME_MS;
    }
    // A slot is released a moment after the unsubscribe; the next test starts from zero.
    await vi.waitFor(async () => expect(await redis.zCard(`${keyPrefix}:total`)).toBe(0));
  });
  afterAll(async () => {
    for (const instance of services()) await instance.onModuleDestroy();
    await redis.quit();
    await database.close();
  });

  const newEvent = () => createTestEvent(db, { strategy: BOOKING_STRATEGY.PESSIMISTIC, seats: 1 });
  async function listen(eventId: string, address: string, via = service) {
    const state: { completed: boolean; messages: number; error?: Error } = {
      completed: false,
      messages: 0,
    };
    const stream = await via.stream(eventId, null, address);
    open.push(
      stream.subscribe({
        next: () => (state.messages += 1),
        error: (error: Error) => (state.error = error),
        complete: () => (state.completed = true),
      })
    );
    return state;
  }
  const refusedWith = async (eventId: string, address: string, via = service): Promise<number> => {
    try {
      await listen(eventId, address, via);
    } catch (error) {
      if (error instanceof HttpException) return error.getStatus();
      throw error;
    }
    return HttpStatus.OK;
  };

  it('has the documented defaults', () => {
    expect([MAX_STREAMS_PER_IP, MAX_STREAMS_TOTAL, STREAM_MAX_LIFETIME_MS]).toEqual([
      10, 500, 600_000,
    ]);
  });

  it('refuses a stream over the per-address cap with 429, lets other addresses in, frees the slot on disconnect', async () => {
    const { eventId } = await newEvent();
    service.maxStreamsPerIp = 2;
    await listen(eventId, ADDRESS);
    await listen(eventId, ADDRESS);

    expect(await refusedWith(eventId, ADDRESS)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(await refusedWith(eventId, OTHER_ADDRESS)).toBe(HttpStatus.OK);
    open[0]?.unsubscribe();

    await vi.waitFor(async () => expect(await refusedWith(eventId, ADDRESS)).toBe(HttpStatus.OK));
  });

  it('refuses a stream over the total cap with 503, whoever asks, frees the slot on disconnect', async () => {
    const { eventId } = await newEvent();
    service.maxStreamsTotal = 2;
    await listen(eventId, ADDRESS);
    await listen(eventId, OTHER_ADDRESS);

    expect(await refusedWith(eventId, '10.0.0.3')).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    open[1]?.unsubscribe();

    await vi.waitFor(async () =>
      expect(await refusedWith(eventId, '10.0.0.3')).toBe(HttpStatus.OK)
    );
  });

  it('counts the total cap over every instance that shares the Redis', async () => {
    const { eventId } = await newEvent();
    for (const instance of services()) instance.maxStreamsTotal = 2;
    await listen(eventId, ADDRESS, service);
    await listen(eventId, OTHER_ADDRESS, other);

    expect(await refusedWith(eventId, '10.0.0.3', service)).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(await refusedWith(eventId, '10.0.0.3', other)).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('counts the per-address cap over every instance that shares the Redis', async () => {
    const { eventId } = await newEvent();
    for (const instance of services()) instance.maxStreamsPerIp = 2;
    await listen(eventId, ADDRESS, service);
    await listen(eventId, ADDRESS, other);

    expect(await refusedWith(eventId, ADDRESS, service)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(await refusedWith(eventId, ADDRESS, other)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(await refusedWith(eventId, OTHER_ADDRESS, other)).toBe(HttpStatus.OK);
  });

  it('frees both slots when a stream ends with an error', async () => {
    service.maxStreamsPerIp = 1;
    service.maxStreamsTotal = 1;
    const failing = await listen(randomUUID(), ADDRESS);
    await vi.waitFor(() => expect(failing.error).toBeInstanceOf(NotFoundException));

    const { eventId } = await newEvent();

    await vi.waitFor(async () => expect(await refusedWith(eventId, ADDRESS)).toBe(HttpStatus.OK));
  });

  it('gives the total slot back when the per-address cap refuses a stream', async () => {
    const { eventId } = await newEvent();
    service.maxStreamsPerIp = 1;
    service.maxStreamsTotal = 2;
    await listen(eventId, ADDRESS);

    expect(await refusedWith(eventId, ADDRESS)).toBe(HttpStatus.TOO_MANY_REQUESTS);

    expect(await refusedWith(eventId, OTHER_ADDRESS)).toBe(HttpStatus.OK);
  });

  it('gives the total slot back when the address slot cannot be taken because Redis fails', async () => {
    /** Fails the address counter only, like a Redis error between the two acquires. */
    class FailingAddressSlots extends SlotLimiter {
      override acquire(key: string, slotId: string, limit: number, lifetimeMs: number) {
        if (key.includes(':ip:')) return Promise.reject(new Error('redis down'));
        return super.acquire(key, slotId, limit, lifetimeMs);
      }
    }
    const broken = ownSlotKeys(
      new SeatStreamService(
        redis,
        new EventsService(db),
        new FailingAddressSlots(redis, new SystemClock())
      )
    );
    const { eventId } = await newEvent();

    await expect(broken.stream(eventId, null, ADDRESS)).rejects.toThrow('redis down');

    expect(await redis.zCard(`${broken.slotKeyPrefix}:total`)).toBe(0);
  });

  it('ends a stream after its maximum lifetime and frees its slot and its Redis subscription', async () => {
    const { eventId } = await newEvent();
    service.maxLifetimeMs = 50;
    service.maxStreamsPerIp = 1;
    const viewer = await listen(eventId, ADDRESS);

    await vi.waitFor(() => expect(viewer.completed).toBe(true));

    await vi.waitFor(async () =>
      expect((await redis.pubSubNumSub(seatChannel(eventId)))[seatChannel(eventId)]).toBe(0)
    );
    await vi.waitFor(async () => expect(await refusedWith(eventId, ADDRESS)).toBe(HttpStatus.OK));
  });

  it('keeps a stream open before its maximum lifetime', async () => {
    const { eventId } = await newEvent();
    const viewer = await listen(eventId, ADDRESS);
    await vi.waitFor(() => expect(viewer.messages).toBe(1));

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(viewer.completed).toBe(false);
  });
});

describe('SeatStreamService after the subscriber connection was lost', () => {
  const database = openTestDatabase();
  const { db } = database;
  afterAll(() => database.close());

  /** Kills the server side of the service's subscriber connection, found by its client name. */
  async function dropConnection(redis: Redis, name: string): Promise<void> {
    const list = await redis.sendCommand<string>(['CLIENT', 'LIST']);
    const line = list.split('\n').find((entry) => entry.includes(`name=${name} `));
    const id = /id=(\d+)/.exec(line ?? '')?.[1];
    if (id === undefined) throw new Error('subscriber connection not found');
    await redis.sendCommand(['CLIENT', 'KILL', 'ID', id]);
  }

  it('ends every open stream once it is connected again, so clients reconnect and read a fresh snapshot', async () => {
    const redis = await openTestRedis();
    const name = `seat-stream-spec-${randomUUID()}`;
    const duplicate = redis.duplicate.bind(redis);
    vi.spyOn(redis, 'duplicate').mockImplementation(() => duplicate({ name }));
    const service = ownSlotKeys(
      new SeatStreamService(redis, new EventsService(db), slotsOf(redis))
    );
    await service.onModuleInit();
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const messages: SeatStreamMessage[] = [];
    let completed = false;
    (await service.stream(eventId, null, ADDRESS)).subscribe({
      next: (message) => messages.push(message),
      complete: () => (completed = true),
    });
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    await dropConnection(redis, name);

    await vi.waitFor(() => expect(completed).toBe(true));
    await service.onModuleDestroy();
    await redis.quit();
  });
});

describe('SeatStreamService shutdown', () => {
  const database = openTestDatabase();
  afterAll(() => database.close());

  it('completes the open streams and closes its Redis connection', async () => {
    const redis = await openTestRedis();
    const service = ownSlotKeys(
      new SeatStreamService(redis, new EventsService(database.db), slotsOf(redis))
    );
    await service.onModuleInit();
    const { eventId } = await createTestEvent(database.db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const messages: SeatStreamMessage[] = [];
    let completed = false;
    (await service.stream(eventId, null, ADDRESS)).subscribe({
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
