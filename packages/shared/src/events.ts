import { array, coerce, type infer as ZodInfer, iso, number, object, string, uuid } from 'zod';

import { BookingStrategySchema, SeatStatusSchema } from './booking.js';
import { WaitingRoomCapacitySchema } from './waiting-room.js';

export const EVENT_LIST_LIMITS = {
  PAGE_DEFAULT: 50,
  PAGE_MAX: 100,
  QUERY_MAX: 120,
} as const;

/** Keyset cursor for `GET /api/events` (`<startsAt ISO>|<event uuid>`), ordered `(startsAt ASC, id ASC)`. */
export const EventCursorSchema = string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
);

export const EventListQuerySchema = object({
  q: string().trim().min(1).max(EVENT_LIST_LIMITS.QUERY_MAX).optional(),
  from: iso.datetime().optional(),
  to: iso.datetime().optional(),
  maxPriceCents: coerce.number().int().positive().optional(),
  cursor: EventCursorSchema.optional(),
  limit: coerce
    .number()
    .int()
    .min(1)
    .max(EVENT_LIST_LIMITS.PAGE_MAX)
    .default(EVENT_LIST_LIMITS.PAGE_DEFAULT),
});

export const EventSummarySchema = object({
  id: uuid(),
  name: string(),
  startsAt: iso.datetime(),
  venueName: string(),
  strategy: BookingStrategySchema,
  /** Null: no waiting room. */
  waitingRoomCapacity: WaitingRoomCapacitySchema.nullable(),
});

export const EventListResponseSchema = object({
  items: array(EventSummarySchema),
  nextCursor: EventCursorSchema.nullable(),
});

export const SeatSchema = object({
  id: uuid(),
  section: string(),
  row: number().int(),
  number: number().int(),
  priceCents: number().int(),
  status: SeatStatusSchema,
});

export const EventDetailSchema = EventSummarySchema.extend({ seats: array(SeatSchema) });

export type EventListQuery = ZodInfer<typeof EventListQuerySchema>;
export type EventListResponse = ZodInfer<typeof EventListResponseSchema>;
export type EventSummary = ZodInfer<typeof EventSummarySchema>;
export type Seat = ZodInfer<typeof SeatSchema>;
export type EventDetail = ZodInfer<typeof EventDetailSchema>;
