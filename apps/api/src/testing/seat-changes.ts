import { randomUUID } from 'node:crypto';

import { SEAT_STATUS, type SeatChange, SeatChangeSchema } from '@app/shared';
import { vi } from 'vitest';

import type { Redis } from '../infrastructure/redis/redis.module.js';
import { seatChannel } from '../modules/bookings/index.js';

/**
 * Collects what is published for one event. `settle` waits until everything published before it
 * has arrived: it sends a marker over `publisherRedis` (the connection the service under test
 * publishes with), and Redis keeps the order of one connection. `changes` holds what has arrived
 * as of the last `settle`.
 */
export async function watchSeatChanges(
  publisherRedis: Redis,
  eventId: string
): Promise<{ changes: SeatChange[]; settle(): Promise<void>; stop(): Promise<void> }> {
  const subscriber = publisherRedis.duplicate();
  await subscriber.connect();
  const received: SeatChange[] = [];
  const markers = new Set<string>();
  await subscriber.subscribe(seatChannel(eventId), (message) => {
    received.push(SeatChangeSchema.parse(JSON.parse(message)));
  });
  const changes: SeatChange[] = [];
  return {
    changes,
    async settle() {
      const marker = randomUUID();
      markers.add(marker);
      const change: SeatChange = {
        eventId,
        seatId: marker,
        status: SEAT_STATUS.AVAILABLE,
        at: new Date(0).toISOString(),
      };
      await publisherRedis.publish(seatChannel(eventId), JSON.stringify(change));
      await vi.waitFor(() => {
        if (!received.some(({ seatId }) => seatId === marker)) throw new Error('not arrived yet');
      });
      changes.splice(0, changes.length, ...received.filter(({ seatId }) => !markers.has(seatId)));
    },
    async stop() {
      await subscriber.quit();
    },
  };
}
