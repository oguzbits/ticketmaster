import { z } from 'zod';

import { BookingStrategySchema } from './booking.js';
import { EventSummarySchema } from './events.js';
import { WaitingRoomCapacitySchema } from './waiting-room.js';

export const VenueSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  seatCount: z.number().int().nonnegative(),
});

export const VenueListResponseSchema = z.array(VenueSchema);

export const CreateEventRequestSchema = z.object({
  venueId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  startsAt: z.iso.datetime(),
  strategy: BookingStrategySchema,
  waitingRoomCapacity: WaitingRoomCapacitySchema.nullable().default(null),
});

/** An own event with its sales; the counts are aggregated in the database. */
export const OrganizerEventSchema = EventSummarySchema.extend({
  seatCount: z.number().int().nonnegative(),
  soldCount: z.number().int().nonnegative(),
  heldCount: z.number().int().nonnegative(),
  utilization: z.number().min(0).max(1),
});

export const OrganizerEventListResponseSchema = z.array(OrganizerEventSchema);

export const SetStrategyRequestSchema = z.object({ strategy: BookingStrategySchema });

export type Venue = z.infer<typeof VenueSchema>;
export type CreateEventRequest = z.infer<typeof CreateEventRequestSchema>;
export type OrganizerEvent = z.infer<typeof OrganizerEventSchema>;
export type SetStrategyRequest = z.infer<typeof SetStrategyRequestSchema>;
