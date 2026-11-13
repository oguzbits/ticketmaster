import { z } from 'zod';

import { BookingStrategySchema, SeatStatusSchema } from './booking.js';

export const EventSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  startsAt: z.iso.datetime(),
  venueName: z.string(),
  strategy: BookingStrategySchema,
});

export const EventListResponseSchema = z.array(EventSummarySchema);

export const SeatSchema = z.object({
  id: z.uuid(),
  section: z.string(),
  row: z.number().int(),
  number: z.number().int(),
  priceCents: z.number().int(),
  status: SeatStatusSchema,
});

export const EventDetailSchema = EventSummarySchema.extend({ seats: z.array(SeatSchema) });

export type EventSummary = z.infer<typeof EventSummarySchema>;
export type Seat = z.infer<typeof SeatSchema>;
export type EventDetail = z.infer<typeof EventDetailSchema>;
