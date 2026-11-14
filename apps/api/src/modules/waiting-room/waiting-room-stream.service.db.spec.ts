import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, WAITING_ROOM_STATE, type WaitingRoomStatus } from '@app/shared';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SlotLimiter } from '../../infrastructure/rate-limit/slot-limiter.js';
import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { lockSpecs } from '../../testing/spec-lock.js';
import { SPEC_NOW } from '../../testing/time.js';
import { RedisWaitingRoomStore } from './adapters/redis-waiting-room-store.js';
import { WaitingRoomService } from './waiting-room.service.js';
import { WaitingRoomStreamService } from './waiting-room-stream.service.js';

const POLL_MS = 20;
const CAPACITY = 5;

describe('WaitingRoomStreamService', () => {
  const database = openTestDatabase();
  const { db } = database;
  let redis: Redis;
  let store: RedisWaitingRoomStore;
  let stream: WaitingRoomStreamService;
  // Its own counter: the default key is shared with every other spec and the dev stack.
  const slotKey = `streams:test:${randomUUID()}`;
  const open: Subscription[] = [];
  let unlock: () => Promise<void>;

  beforeAll(async () => {
    // The admitDue of another file would admit the users queued here.
    unlock = await lockSpecs(db, 'waiting-room');
    redis = await openTestRedis();
    store = new RedisWaitingRoomStore(redis);
    const service = new WaitingRoomService(db, { now: () => SPEC_NOW }, store);
    stream = new WaitingRoomStreamService(service, new SlotLimiter(redis, { now: () => SPEC_NOW }));
    stream.pollMs = POLL_MS;
    stream.slotKey = slotKey;
  });
  afterEach(async () => {
    for (const subscription of open.splice(0)) subscription.unsubscribe();
    stream.maxStreams = 200;
    // A slot is released a moment after the unsubscribe; the next test starts from zero.
    await vi.waitFor(async () => expect(await redis.zCard(slotKey)).toBe(0));
  });
  afterAll(async () => {
    await unlock();
    await redis.quit();
    await database.close();
  });

  async function queue(users: number) {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 0,
      waitingRoomCapacity: CAPACITY,
    });
    const userIds = Array.from({ length: users }, () => randomUUID());
    for (const [index, userId] of userIds.entries()) {
      await store.join(eventId, userId, new Date(SPEC_NOW.getTime() + index));
    }
    return { eventId, userIds };
  }
  const admit = (eventId: string, userIds: string[]) =>
    store.admit({
      eventId,
      userIds,
      capacity: CAPACITY,
      now: SPEC_NOW,
      expiresAt: new Date(SPEC_NOW.getTime() + 60_000),
    });

  async function listen(eventId: string, userId: string) {
    const messages: WaitingRoomStatus[] = [];
    const state = { completed: false };
    const subscription = (await stream.stream(eventId, userId)).subscribe({
      next: (message) => messages.push(message),
      complete: () => (state.completed = true),
    });
    open.push(subscription);
    return { messages, state, subscription };
  }
  const settle = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  it('emits the position and ends with ADMITTED', async () => {
    const { eventId, userIds } = await queue(2);
    const [first = '', second = ''] = userIds;
    const { messages, state } = await listen(eventId, second);
    await expect.poll(() => messages).toHaveLength(1);

    await admit(eventId, [first]);
    await expect.poll(() => messages).toHaveLength(2);
    await admit(eventId, [second]);

    await expect.poll(() => state.completed).toBe(true);
    expect(messages.map(({ state: value, position }) => ({ value, position }))).toEqual([
      { value: WAITING_ROOM_STATE.WAITING, position: 2 },
      { value: WAITING_ROOM_STATE.WAITING, position: 1 },
      { value: WAITING_ROOM_STATE.ADMITTED, position: null },
    ]);
  });

  it('emits on change only', async () => {
    const { eventId, userIds } = await queue(2);
    const [, second = ''] = userIds;
    const { messages } = await listen(eventId, second);
    await expect.poll(() => messages).toHaveLength(1);

    await settle(POLL_MS * 5);

    expect(messages).toHaveLength(1);
  });

  it('ends at once for a user who is not queued', async () => {
    const { eventId } = await queue(0);
    const { messages, state } = await listen(eventId, randomUUID());

    await expect.poll(() => state.completed).toBe(true);
    expect(messages.map(({ state: value }) => value)).toEqual([WAITING_ROOM_STATE.NONE]);
  });

  it('answers 503 over the cap and gives the slot back when the stream ends or aborts', async () => {
    const { eventId, userIds } = await queue(2);
    const [first = '', second = ''] = userIds;
    stream.maxStreams = 1;
    const ending = await listen(eventId, first);
    const refused = await listen(eventId, second).catch((error: Error) => error);
    expect(refused).toBeInstanceOf(ServiceUnavailableException);

    await admit(eventId, [first]);
    await expect.poll(() => ending.state.completed).toBe(true);
    await vi.waitFor(async () => expect(await redis.zCard(slotKey)).toBe(0));

    const again = await listen(eventId, second);
    expect(await redis.zCard(slotKey)).toBe(1);
    again.subscription.unsubscribe();
    await vi.waitFor(async () => expect(await redis.zCard(slotKey)).toBe(0));
  });
});
