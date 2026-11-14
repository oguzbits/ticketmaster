import {
  EventListResponseSchema,
  type EventSummary,
  EventSummarySchema,
  SeatSchema,
} from '@app/shared';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CacheAside } from '../../infrastructure/cache/index.js';

export const EVENT_CACHE = { LIST: 'events.list', DETAIL: 'events.detail' } as const;
export const LIST_KEY = 'events:list';
export const detailKey = (eventId: string): string => `events:detail:${eventId}`;

/** An event with its seats but without their status: the status is live data, never cached. */
export const EventLayoutSchema = EventSummarySchema.extend({
  seats: z.array(SeatSchema.omit({ status: true })),
});

export type EventLayout = z.infer<typeof EventLayoutSchema>;

/**
 * The public event list and the layout of public events, cached in Redis for a few seconds.
 * Only public data goes through here: the callers load sandbox events (private to one demo user)
 * and every seat status straight from the database.
 */
@Injectable()
export class EventCache {
  constructor(
    private readonly cache: CacheAside,
    @Inject(APP_CONFIG) private readonly config: Env
  ) {}

  list(load: () => Promise<EventSummary[]>): Promise<EventSummary[]> {
    return this.cache
      .getOrLoad(EVENT_CACHE.LIST, LIST_KEY, EventListResponseSchema, this.ttl, load)
      .then((events) => events ?? []);
  }

  detail(id: string, load: () => Promise<EventLayout | null>): Promise<EventLayout | null> {
    return this.cache.getOrLoad(
      EVENT_CACHE.DETAIL,
      detailKey(id),
      EventLayoutSchema,
      this.ttl,
      load
    );
  }

  /** List key and the detail key of `eventId`; call it after the change is committed. */
  async invalidate(eventId: string): Promise<void> {
    // With the cache off nothing was stored, so there is nothing to delete.
    if (this.ttl === 0) return;
    await this.cache.invalidate(LIST_KEY, detailKey(eventId));
  }

  private get ttl(): number {
    return this.config.EVENT_CACHE_TTL_SECONDS;
  }
}
