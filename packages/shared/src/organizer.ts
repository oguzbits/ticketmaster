import { array, coerce, type infer as ZodInfer, iso, number, object, string, uuid } from 'zod';

import { BookingStrategySchema } from './booking.js';
import { EventSummarySchema } from './events.js';
import { WaitingRoomCapacitySchema } from './waiting-room.js';

export const VENUE_LIST_LIMITS = {
  PAGE_DEFAULT: 50,
  PAGE_MAX: 100,
  QUERY_MAX: 120,
} as const;

/** Keyset cursor for `GET /api/venues`: base64url-encoded `[name, id]`, ordered `(name ASC, id ASC)`. */
export const VenueCursorSchema = string().regex(/^[A-Za-z0-9_-]{1,512}$/);

export const VenueListQuerySchema = object({
  q: string().trim().min(1).max(VENUE_LIST_LIMITS.QUERY_MAX).optional(),
  cursor: VenueCursorSchema.optional(),
  limit: coerce
    .number()
    .int()
    .min(1)
    .max(VENUE_LIST_LIMITS.PAGE_MAX)
    .default(VENUE_LIST_LIMITS.PAGE_DEFAULT),
});

export const VenueSchema = object({
  id: uuid(),
  name: string(),
  seatCount: number().int().nonnegative(),
});

export const VenueListResponseSchema = object({
  items: array(VenueSchema),
  nextCursor: VenueCursorSchema.nullable(),
});

export const CreateEventRequestSchema = object({
  venueId: uuid(),
  name: string().trim().min(1).max(120),
  startsAt: iso.datetime(),
  strategy: BookingStrategySchema,
  waitingRoomCapacity: WaitingRoomCapacitySchema.nullable().default(null),
});

/** An own event with its sales; the counts are aggregated in the database. */
export const OrganizerEventSchema = EventSummarySchema.extend({
  seatCount: number().int().nonnegative(),
  soldCount: number().int().nonnegative(),
  heldCount: number().int().nonnegative(),
  utilization: number().min(0).max(1),
});

export const OrganizerEventListResponseSchema = array(OrganizerEventSchema);

export const SetStrategyRequestSchema = object({ strategy: BookingStrategySchema });

export type Venue = ZodInfer<typeof VenueSchema>;
export type VenueListQuery = ZodInfer<typeof VenueListQuerySchema>;
export type VenueListResponse = ZodInfer<typeof VenueListResponseSchema>;
export type CreateEventRequest = ZodInfer<typeof CreateEventRequestSchema>;
export type OrganizerEvent = ZodInfer<typeof OrganizerEventSchema>;
export type SetStrategyRequest = ZodInfer<typeof SetStrategyRequestSchema>;
