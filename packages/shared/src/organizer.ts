import { array, type infer as ZodInfer, iso, number, object, string, uuid } from 'zod';

import { BookingStrategySchema } from './booking.js';
import { EventSummarySchema } from './events.js';
import { WaitingRoomCapacitySchema } from './waiting-room.js';

export const VenueSchema = object({
  id: uuid(),
  name: string(),
  seatCount: number().int().nonnegative(),
});

export const VenueListResponseSchema = array(VenueSchema);

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
export type CreateEventRequest = ZodInfer<typeof CreateEventRequestSchema>;
export type OrganizerEvent = ZodInfer<typeof OrganizerEventSchema>;
export type SetStrategyRequest = ZodInfer<typeof SetStrategyRequestSchema>;
