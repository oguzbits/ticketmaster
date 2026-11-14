import type { WaitingRoomStatus } from '@app/shared';

export const WAITING_ROOM_STORE = Symbol('WAITING_ROOM_STORE');

/** The queue and the admissions of every waiting room; the Redis adapter implements it. */
export interface WaitingRoomStore {
  /** Idempotent: a user who is queued or admitted keeps their place. */
  join(eventId: string, userId: string, now: Date): Promise<void>;
  /** Removes the user from the queue and from the admissions. */
  leave(eventId: string, userId: string): Promise<void>;
  status(eventId: string, userId: string, now: Date): Promise<WaitingRoomStatus>;
  isAdmitted(eventId: string, userId: string, now: Date): Promise<boolean>;
  snapshot(
    eventId: string,
    now: Date,
    headSize: number
  ): Promise<{ admitted: number; head: string[] }>;
  /** Moves the given users from the queue to the admissions, atomically, never past `capacity` live admissions. Returns the users that moved. */
  admit(input: {
    eventId: string;
    userIds: readonly string[];
    capacity: number;
    now: Date;
    expiresAt: Date;
  }): Promise<string[]>;
}
