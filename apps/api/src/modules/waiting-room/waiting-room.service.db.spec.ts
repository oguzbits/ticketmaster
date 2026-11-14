import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, WAITING_ROOM_STATE } from '@app/shared';
import { ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { lockSpecs } from '../../testing/spec-lock.js';
import { SPEC_NOW } from '../../testing/time.js';
import { RedisWaitingRoomStore } from './adapters/redis-waiting-room-store.js';
import { ADMISSION_TTL_SECONDS } from './domain/admission-policy.js';
import { WaitingRoomService } from './waiting-room.service.js';

const SECOND_MS = 1000;
const at = (offsetMs: number) => new Date(SPEC_NOW.getTime() + offsetMs);

describe('WaitingRoomService', () => {
  const database = openTestDatabase();
  const { db } = database;
  let redis: Redis;
  let service: WaitingRoomService;
  let unlock: () => Promise<void>;
  let now = SPEC_NOW;

  beforeAll(async () => {
    // admitDue works on every event with a waiting room, so no other file may queue meanwhile.
    unlock = await lockSpecs(db, 'waiting-room');
    redis = await openTestRedis();
    service = new WaitingRoomService(db, { now: () => now }, new RedisWaitingRoomStore(redis));
  });
  afterAll(async () => {
    await unlock();
    await redis.quit();
    await database.close();
  });

  async function room(capacity: number | undefined, users: number) {
    const { eventId } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 0,
      ...(capacity === undefined ? {} : { waitingRoomCapacity: capacity }),
    });
    const userIds = Array.from({ length: users }, () => randomUUID());
    return { eventId, userIds };
  }
  const states = (eventId: string, userIds: string[]) =>
    Promise.all(userIds.map(async (id) => (await service.status(eventId, id)).state));

  it('admitDue admits the first users up to the capacity and no more on the next tick', async () => {
    const { eventId, userIds } = await room(3, 5);
    for (const [index, userId] of userIds.entries()) {
      now = at(index * SECOND_MS);
      await service.join(eventId, userId);
    }
    now = SPEC_NOW;

    expect(await service.admitDue()).toBeGreaterThanOrEqual(3);
    await service.admitDue();

    expect(await states(eventId, userIds)).toEqual([
      WAITING_ROOM_STATE.ADMITTED,
      WAITING_ROOM_STATE.ADMITTED,
      WAITING_ROOM_STATE.ADMITTED,
      WAITING_ROOM_STATE.WAITING,
      WAITING_ROOM_STATE.WAITING,
    ]);
  });

  it('admitDue admits a waiting user after an admission expired', async () => {
    const { eventId, userIds } = await room(1, 2);
    for (const [index, userId] of userIds.entries()) {
      now = at(index);
      await service.join(eventId, userId);
    }
    now = SPEC_NOW;
    await service.admitDue();
    expect(await states(eventId, userIds)).toEqual([
      WAITING_ROOM_STATE.ADMITTED,
      WAITING_ROOM_STATE.WAITING,
    ]);

    now = at((ADMISSION_TTL_SECONDS + 1) * SECOND_MS);
    await service.admitDue();

    expect(await states(eventId, userIds)).toEqual([
      WAITING_ROOM_STATE.NONE,
      WAITING_ROOM_STATE.ADMITTED,
    ]);
    now = SPEC_NOW;
  });

  it('admitDue skips events without a waiting room', async () => {
    const { eventId } = await room(undefined, 0);
    const store = new RedisWaitingRoomStore(redis);
    const userId = randomUUID();
    await store.join(eventId, userId, SPEC_NOW);

    await service.admitDue();

    expect((await service.status(eventId, userId)).state).toBe(WAITING_ROOM_STATE.WAITING);
  });

  it('assertAdmitted throws Forbidden before and after the admission, passes during it', async () => {
    const { eventId, userIds } = await room(1, 1);
    const [userId = ''] = userIds;
    now = SPEC_NOW;
    await expect(service.assertAdmitted(eventId, userId)).rejects.toThrow(ForbiddenException);

    await service.join(eventId, userId);
    await expect(service.assertAdmitted(eventId, userId)).rejects.toThrow(ForbiddenException);
    await service.admitDue();
    await expect(service.assertAdmitted(eventId, userId)).resolves.toBeUndefined();

    now = at((ADMISSION_TTL_SECONDS + 1) * SECOND_MS);
    await expect(service.assertAdmitted(eventId, userId)).rejects.toThrow(ForbiddenException);
    now = SPEC_NOW;
  });

  it('assertAdmitted passes for an event without a waiting room', async () => {
    const { eventId } = await room(undefined, 0);

    await expect(service.assertAdmitted(eventId, randomUUID())).resolves.toBeUndefined();
  });
});
