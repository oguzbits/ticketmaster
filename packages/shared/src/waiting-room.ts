import { z } from 'zod';

export const WAITING_ROOM_STATE = {
  NONE: 'NONE',
  WAITING: 'WAITING',
  ADMITTED: 'ADMITTED',
} as const;

export const MAX_ADMISSION_CAPACITY = 1000;

export const WaitingRoomCapacitySchema = z.number().int().min(1).max(MAX_ADMISSION_CAPACITY);

export const WaitingRoomStatusSchema = z.object({
  state: z.enum(WAITING_ROOM_STATE),
  /** 1-based, only while WAITING. */
  position: z.number().int().min(1).nullable(),
  /** Length of the queue. */
  waiting: z.number().int().min(0),
  /** Only while ADMITTED. */
  admittedUntil: z.iso.datetime().nullable(),
});

export const SetWaitingRoomRequestSchema = z.object({
  capacity: WaitingRoomCapacitySchema.nullable(),
});

export type WaitingRoomState = (typeof WAITING_ROOM_STATE)[keyof typeof WAITING_ROOM_STATE];
export type WaitingRoomStatus = z.infer<typeof WaitingRoomStatusSchema>;
export type SetWaitingRoomRequest = z.infer<typeof SetWaitingRoomRequestSchema>;
