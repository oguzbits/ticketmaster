import { enum as zEnum, type infer as ZodInfer, iso, number, object, string } from 'zod';

export const WAITING_ROOM_STATE = {
  NONE: 'NONE',
  WAITING: 'WAITING',
  ADMITTED: 'ADMITTED',
} as const;

export const MAX_ADMISSION_CAPACITY = 1000;

export const WaitingRoomCapacitySchema = number().int().min(1).max(MAX_ADMISSION_CAPACITY);

export const WaitingRoomStatusSchema = object({
  state: zEnum(WAITING_ROOM_STATE),
  /** 1-based, only while WAITING. */
  position: number().int().min(1).nullable(),
  /** Length of the queue. */
  waiting: number().int().min(0),
  /** Only while ADMITTED. */
  admittedUntil: iso.datetime().nullable(),
  /** Signed HMAC admission token; present while ADMITTED. */
  admissionToken: string().min(1).nullable(),
});

export const SetWaitingRoomRequestSchema = object({
  capacity: WaitingRoomCapacitySchema.nullable(),
});

export type WaitingRoomState = (typeof WAITING_ROOM_STATE)[keyof typeof WAITING_ROOM_STATE];
export type WaitingRoomStatus = ZodInfer<typeof WaitingRoomStatusSchema>;
export type SetWaitingRoomRequest = ZodInfer<typeof SetWaitingRoomRequestSchema>;
