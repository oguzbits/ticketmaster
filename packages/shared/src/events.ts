import { array, type infer as ZodInfer, iso, number, object, string, uuid } from 'zod';

import { BookingStrategySchema, SeatStatusSchema } from './booking.js';
import { WaitingRoomCapacitySchema } from './waiting-room.js';

export const EventSummarySchema = object({
  id: uuid(),
  name: string(),
  startsAt: iso.datetime(),
  venueName: string(),
  strategy: BookingStrategySchema,
  /** Null: no waiting room. */
  waitingRoomCapacity: WaitingRoomCapacitySchema.nullable(),
});

export const EventListResponseSchema = array(EventSummarySchema);

export const SeatSchema = object({
  id: uuid(),
  section: string(),
  row: number().int(),
  number: number().int(),
  priceCents: number().int(),
  status: SeatStatusSchema,
});

export const EventDetailSchema = EventSummarySchema.extend({ seats: array(SeatSchema) });

export type EventSummary = ZodInfer<typeof EventSummarySchema>;
export type Seat = ZodInfer<typeof SeatSchema>;
export type EventDetail = ZodInfer<typeof EventDetailSchema>;
