import { randomUUID } from 'node:crypto';

import { BOOKING_STRATEGY, type BookingStrategy } from '@app/shared';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../../core/clock.js';
import { SPAN_ATTR, SPAN_NAME } from '../../infrastructure/tracing/index.js';
import { startTestTracing } from '../../infrastructure/tracing/testing/index.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import { SPEC_NOW } from '../../testing/time.js';
import type { BookingsService } from './bookings.service.js';
import { HOLD_OUTCOME } from './domain/seat-reservation.js';
import { createBookingsService } from './testing/create-bookings-service.js';

const clock: Clock = { now: () => SPEC_NOW };

describe('hold strategy span', () => {
  const database = openTestDatabase();
  const { db } = database;
  let service: BookingsService;
  let shutdown: (() => Promise<void>) | undefined;
  let exporter: ReturnType<typeof startTestTracing>['exporter'];

  beforeAll(async () => {
    service = createBookingsService(db, await openTestRedis(), clock);
  });
  afterAll(() => database.close());
  afterEach(() => shutdown?.());

  function trace(): void {
    ({ exporter, shutdown } = startTestTracing());
  }

  const holdSpans = () =>
    exporter.getFinishedSpans().filter((span) => span.name === SPAN_NAME.HOLD_STRATEGY);

  async function seatOf(strategy: BookingStrategy): Promise<{ eventId: string; seatId: string }> {
    const { eventId, seatIds } = await createTestEvent(db, { strategy, seats: 1 });
    const [seatId] = seatIds;
    if (seatId === undefined) throw new Error('test event has no seat');
    return { eventId, seatId };
  }

  it.each(Object.values(BOOKING_STRATEGY))(
    'wraps a %s hold in one span that names the strategy',
    async (strategy) => {
      trace();
      const seat = await seatOf(strategy);

      await service.hold({
        eventId: seat.eventId,
        seatIds: [seat.seatId],
        userId: randomUUID(),
        requestId: null,
      });

      const spans = holdSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]?.attributes[SPAN_ATTR.STRATEGY]).toBe(strategy);
      expect(Object.values(spans[0]?.attributes ?? {})).not.toContain(seat.seatId);
    }
  );

  it('ends the span without an error when the seat is taken', async () => {
    trace();
    const seat = await seatOf(BOOKING_STRATEGY.OPTIMISTIC);
    await service.hold({
      eventId: seat.eventId,
      seatIds: [seat.seatId],
      userId: randomUUID(),
      requestId: null,
    });

    const second = await service.hold({
      eventId: seat.eventId,
      seatIds: [seat.seatId],
      userId: randomUUID(),
      requestId: null,
    });

    expect(second).toEqual({ outcome: HOLD_OUTCOME.SEAT_TAKEN });
    const spans = holdSpans();
    expect(spans).toHaveLength(2);
    expect(spans.map((span) => span.status.code)).not.toContain(SpanStatusCode.ERROR);
  });

  it('ends the span as failed when the strategy throws', async () => {
    trace();
    const closedRedis = await openTestRedis();
    await closedRedis.quit();
    const failing = createBookingsService(db, closedRedis, clock);
    const seat = await seatOf(BOOKING_STRATEGY.REDIS_LOCK);

    await expect(
      failing.hold({
        eventId: seat.eventId,
        seatIds: [seat.seatId],
        userId: randomUUID(),
        requestId: null,
      })
    ).rejects.toThrow();

    const [span] = holdSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes[SPAN_ATTR.STRATEGY]).toBe(BOOKING_STRATEGY.REDIS_LOCK);
  });
});
