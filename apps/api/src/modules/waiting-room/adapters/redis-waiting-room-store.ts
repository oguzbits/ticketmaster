import { WAITING_ROOM_STATE, type WaitingRoomStatus } from '@app/shared';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { REDIS, type Redis } from '../../../infrastructure/redis/redis.module.js';
import type { WaitingRoomStore } from '../domain/waiting-room-store.js';

/** Both keys expire a day after the last write, so the keys of a deleted event vanish. */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** The queue holds user IDs scored by join time, the admissions hold user IDs scored by expiry. */
export const waitingRoomKeys = (eventId: string) => ({
  queue: `waiting-room:${eventId}:queue`,
  admitted: `waiting-room:${eventId}:admitted`,
});

// shortcut: same-millisecond joins order by user ID, upgrade with a counter in the score when
// order within one millisecond matters. An admission is live while its score (expiry) is above now.
// A user who is admitted is not queued again; ZADD NX keeps the place of a queued user.
const JOIN_SCRIPT = `
local expiry = redis.call('ZSCORE', KEYS[2], ARGV[2])
if expiry and tonumber(expiry) > tonumber(ARGV[1]) then
  return 0
end
redis.call('ZADD', KEYS[1], 'NX', ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

// One atomic step: drop the admissions that ran out, then move the users in order and stop at the
// capacity. A user who left the queue meanwhile is skipped.
const ADMIT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
local moved = {}
for i = 5, #ARGV do
  if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then
    break
  end
  if redis.call('ZREM', KEYS[1], ARGV[i]) == 1 then
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[i])
    moved[#moved + 1] = ARGV[i]
  end
end
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return moved
`;

// One atomic read: admit moves a user from the queue to the admissions in one step, so a reader
// that looked at both separately could see the user in neither.
const STATUS_SCRIPT = `
return {redis.call('ZSCORE', KEYS[2], ARGV[1]), redis.call('ZRANK', KEYS[1], ARGV[1]), redis.call('ZCARD', KEYS[1])}
`;

const JoinReplySchema = z.union([z.literal(0), z.literal(1)]);
const AdmitReplySchema = z.array(z.string());
const StatusReplySchema = z.tuple([z.string().nullable(), z.number().nullable(), z.number()]);

/** The queue and the admissions of a waiting room as two sorted sets in Redis. */
@Injectable()
export class RedisWaitingRoomStore implements WaitingRoomStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async join(eventId: string, userId: string, now: Date): Promise<void> {
    const keys = waitingRoomKeys(eventId);
    const reply = await this.redis.eval(JOIN_SCRIPT, {
      keys: [keys.queue, keys.admitted],
      arguments: [String(now.getTime()), userId, String(KEY_TTL_MS)],
    });
    JoinReplySchema.parse(reply);
  }

  async leave(eventId: string, userId: string): Promise<void> {
    const keys = waitingRoomKeys(eventId);
    await this.redis.multi().zRem(keys.queue, userId).zRem(keys.admitted, userId).exec();
  }

  async status(eventId: string, userId: string, now: Date): Promise<WaitingRoomStatus> {
    const keys = waitingRoomKeys(eventId);
    const reply = await this.redis.eval(STATUS_SCRIPT, {
      keys: [keys.queue, keys.admitted],
      arguments: [userId],
    });
    const [expiry, rank, waiting] = StatusReplySchema.parse(reply);
    if (expiry !== null && Number(expiry) > now.getTime()) {
      return {
        state: WAITING_ROOM_STATE.ADMITTED,
        position: null,
        waiting,
        admittedUntil: new Date(Number(expiry)).toISOString(),
      };
    }
    if (rank !== null) {
      return {
        state: WAITING_ROOM_STATE.WAITING,
        position: rank + 1,
        waiting,
        admittedUntil: null,
      };
    }
    return { state: WAITING_ROOM_STATE.NONE, position: null, waiting, admittedUntil: null };
  }

  async isAdmitted(eventId: string, userId: string, now: Date): Promise<boolean> {
    const expiry = await this.redis.zScore(waitingRoomKeys(eventId).admitted, userId);
    return expiry !== null && expiry > now.getTime();
  }

  async snapshot(
    eventId: string,
    now: Date,
    headSize: number
  ): Promise<{ admitted: number; head: string[] }> {
    const keys = waitingRoomKeys(eventId);
    const [admitted, head] = await Promise.all([
      this.redis.zCount(keys.admitted, `(${now.getTime()}`, '+inf'),
      this.redis.zRange(keys.queue, 0, headSize - 1),
    ]);
    return { admitted, head };
  }

  async admit(input: {
    eventId: string;
    userIds: readonly string[];
    capacity: number;
    now: Date;
    expiresAt: Date;
  }): Promise<string[]> {
    const keys = waitingRoomKeys(input.eventId);
    const reply = await this.redis.eval(ADMIT_SCRIPT, {
      keys: [keys.queue, keys.admitted],
      arguments: [
        String(input.now.getTime()),
        String(input.expiresAt.getTime()),
        String(input.capacity),
        String(KEY_TTL_MS),
        ...input.userIds,
      ],
    });
    return AdmitReplySchema.parse(reply);
  }
}
