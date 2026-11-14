import { randomUUID } from 'node:crypto';

import { WAITING_ROOM_STATE } from '@app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Redis } from '../../../infrastructure/redis/redis.module.js';
import { openTestRedis } from '../../../testing/redis.js';
import { SPEC_NOW } from '../../../testing/time.js';
import { RedisWaitingRoomStore, waitingRoomKeys } from './redis-waiting-room-store.js';

const SECOND_MS = 1000;
const at = (offsetMs: number) => new Date(SPEC_NOW.getTime() + offsetMs);
const ADMISSION_MS = 300 * SECOND_MS;

describe('RedisWaitingRoomStore', () => {
  let redis: Redis;
  let store: RedisWaitingRoomStore;
  const eventIds: string[] = [];
  const freshEvent = () => {
    const eventId = randomUUID();
    eventIds.push(eventId);
    return eventId;
  };
  const admit = (eventId: string, userIds: string[], capacity: number, now = SPEC_NOW) =>
    store.admit({
      eventId,
      userIds,
      capacity,
      now,
      expiresAt: new Date(now.getTime() + ADMISSION_MS),
    });

  beforeAll(async () => {
    redis = await openTestRedis();
    store = new RedisWaitingRoomStore(redis);
  });
  afterAll(async () => {
    await redis.del(eventIds.flatMap((eventId) => Object.values(waitingRoomKeys(eventId))));
    await redis.quit();
  });

  it('queues in join order and reports positions from 1', async () => {
    const eventId = freshEvent();
    await store.join(eventId, 'a', at(0));
    await store.join(eventId, 'b', at(SECOND_MS));
    await store.join(eventId, 'c', at(2 * SECOND_MS));

    const statuses = await Promise.all(
      ['a', 'b', 'c'].map((id) => store.status(eventId, id, SPEC_NOW))
    );

    expect(statuses.map(({ state, position, waiting }) => ({ state, position, waiting }))).toEqual([
      { state: WAITING_ROOM_STATE.WAITING, position: 1, waiting: 3 },
      { state: WAITING_ROOM_STATE.WAITING, position: 2, waiting: 3 },
      { state: WAITING_ROOM_STATE.WAITING, position: 3, waiting: 3 },
    ]);
  });

  it('a second join keeps the place', async () => {
    const eventId = freshEvent();
    await store.join(eventId, 'a', at(0));
    await store.join(eventId, 'b', at(SECOND_MS));

    await store.join(eventId, 'a', at(2 * SECOND_MS));

    expect(await store.status(eventId, 'a', SPEC_NOW)).toMatchObject({ position: 1, waiting: 2 });
  });

  it('joining while admitted does not queue the user', async () => {
    const eventId = freshEvent();
    await store.join(eventId, 'a', at(0));
    await admit(eventId, ['a'], 5);

    await store.join(eventId, 'a', at(SECOND_MS));

    expect(await store.status(eventId, 'a', SPEC_NOW)).toMatchObject({
      state: WAITING_ROOM_STATE.ADMITTED,
      position: null,
      waiting: 0,
    });
  });

  it('two parallel joins of one user leave one entry', async () => {
    const eventId = freshEvent();

    await Promise.all([store.join(eventId, 'a', at(0)), store.join(eventId, 'a', at(1))]);

    expect(await store.snapshot(eventId, SPEC_NOW, 10)).toEqual({ admitted: 0, head: ['a'] });
  });

  it('admit moves users from the front and removes them from the queue', async () => {
    const eventId = freshEvent();
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      await store.join(eventId, id, at(index * SECOND_MS));
    }

    const moved = await admit(eventId, ['a', 'b'], 5);

    expect(moved).toEqual(['a', 'b']);
    expect(await store.snapshot(eventId, SPEC_NOW, 10)).toEqual({ admitted: 2, head: ['c'] });
    expect(await store.status(eventId, 'a', SPEC_NOW)).toEqual({
      state: WAITING_ROOM_STATE.ADMITTED,
      position: null,
      waiting: 1,
      admittedUntil: at(ADMISSION_MS).toISOString(),
    });
    expect(await store.isAdmitted(eventId, 'a', SPEC_NOW)).toBe(true);
    expect(await store.isAdmitted(eventId, 'c', SPEC_NOW)).toBe(false);
  });

  it('admit never exceeds the capacity', async () => {
    const eventId = freshEvent();
    const users = Array.from({ length: 10 }, (_, index) => `user-${index}`);
    for (const [index, id] of users.entries()) await store.join(eventId, id, at(index));

    const moved = await Promise.all(users.map((id) => admit(eventId, [id], 3)));

    expect(moved.flat()).toHaveLength(3);
    expect((await store.snapshot(eventId, SPEC_NOW, 10)).admitted).toBe(3);
  });

  it('an expired admission frees its place', async () => {
    const eventId = freshEvent();
    await store.join(eventId, 'a', at(0));
    await store.join(eventId, 'b', at(1));
    await admit(eventId, ['a'], 1);
    expect(await admit(eventId, ['b'], 1)).toEqual([]);

    const later = at(ADMISSION_MS);

    expect((await store.snapshot(eventId, later, 10)).admitted).toBe(0);
    expect(await store.isAdmitted(eventId, 'a', later)).toBe(false);
    expect(await admit(eventId, ['b'], 1, later)).toEqual(['b']);
  });

  it('admit skips a user who left meanwhile', async () => {
    const eventId = freshEvent();
    await store.join(eventId, 'a', at(0));
    await store.join(eventId, 'b', at(1));
    await store.leave(eventId, 'a');

    expect(await admit(eventId, ['a', 'b'], 5)).toEqual(['b']);
    expect(await store.isAdmitted(eventId, 'a', SPEC_NOW)).toBe(false);
  });

  it('leave removes the user from queue and admissions', async () => {
    const eventId = freshEvent();
    await store.join(eventId, 'admitted', at(0));
    await store.join(eventId, 'waiting', at(1));
    await store.join(eventId, 'stays', at(2));
    await admit(eventId, ['admitted'], 1);

    await store.leave(eventId, 'admitted');
    await store.leave(eventId, 'waiting');

    expect(await store.isAdmitted(eventId, 'admitted', SPEC_NOW)).toBe(false);
    expect(await store.status(eventId, 'waiting', SPEC_NOW)).toMatchObject({
      state: WAITING_ROOM_STATE.NONE,
    });
    expect(await store.snapshot(eventId, SPEC_NOW, 10)).toEqual({ admitted: 0, head: ['stays'] });
  });

  it('status of an unknown user is NONE', async () => {
    const eventId = freshEvent();
    await store.join(eventId, 'a', at(0));

    expect(await store.status(eventId, 'stranger', SPEC_NOW)).toEqual({
      state: WAITING_ROOM_STATE.NONE,
      position: null,
      waiting: 1,
      admittedUntil: null,
    });
  });
});
