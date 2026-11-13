import { randomUUID } from 'node:crypto';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  type BookingStatus,
  EventDetailSchema,
  EventListResponseSchema,
  SEAT_STATUS,
} from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureApp } from '../../app.setup.js';
import { ConfigModule } from '../../config/config.module.js';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { bookings } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { SPEC_NOW } from '../../testing/time.js';
import { EventsModule } from './events.module.js';

const STRATEGY = BOOKING_STRATEGY.PESSIMISTIC;

describe('events endpoints', () => {
  const database = openTestDatabase();
  const { db } = database;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ConfigModule,
        DatabaseModule,
        EventsModule,
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function listedIds(): Promise<string[]> {
    const response = await request(app.getHttpServer()).get('/api/events').expect(200);
    return EventListResponseSchema.parse(response.body).map((event) => event.id);
  }

  it('lists public events and hides sandbox events', async () => {
    const publicEvent = await createTestEvent(db, { strategy: STRATEGY, seats: 1 });
    const sandboxEvent = await createTestEvent(db, {
      strategy: STRATEGY,
      seats: 1,
      sandboxUserId: randomUUID(),
    });

    const ids = await listedIds();

    expect(ids).toContain(publicEvent.eventId);
    expect(ids).not.toContain(sandboxEvent.eventId);
  });

  it('lists events by start time', async () => {
    await createTestEvent(db, { strategy: STRATEGY, seats: 1 });
    const response = await request(app.getHttpServer()).get('/api/events').expect(200);

    const times = EventListResponseSchema.parse(response.body).map((event) =>
      Date.parse(event.startsAt)
    );

    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('detail shows a held seat as HELD and a confirmed one as SOLD', async () => {
    const { eventId, seatIds } = await createTestEvent(db, { strategy: STRATEGY, seats: 5 });
    const [held, sold, expired, free, reheld] = seatIds;
    const book = (seatId: string | undefined, status: BookingStatus) =>
      db.insert(bookings).values({
        eventId,
        seatId: seatId ?? '',
        userId: randomUUID(),
        strategy: STRATEGY,
        status,
        holdExpiresAt: SPEC_NOW,
      });
    await book(held, BOOKING_STATUS.HELD);
    await book(sold, BOOKING_STATUS.CONFIRMED);
    await book(expired, BOOKING_STATUS.EXPIRED);
    // A seat whose earlier hold expired and was held again: the expired booking must not win.
    await book(reheld, BOOKING_STATUS.EXPIRED);
    await book(reheld, BOOKING_STATUS.HELD);

    const response = await request(app.getHttpServer()).get(`/api/events/${eventId}`).expect(200);

    const detail = EventDetailSchema.parse(response.body);
    const statusOf = (seatId: string | undefined) =>
      detail.seats.find((seat) => seat.id === seatId)?.status;
    expect(detail.id).toBe(eventId);
    expect(statusOf(held)).toBe(SEAT_STATUS.HELD);
    expect(statusOf(sold)).toBe(SEAT_STATUS.SOLD);
    expect(statusOf(expired)).toBe(SEAT_STATUS.AVAILABLE);
    expect(statusOf(free)).toBe(SEAT_STATUS.AVAILABLE);
    expect(statusOf(reheld)).toBe(SEAT_STATUS.HELD);
    expect(detail.seats).toHaveLength(5);
  });

  it('detail of a sandbox event is 404', async () => {
    const { eventId } = await createTestEvent(db, {
      strategy: STRATEGY,
      seats: 1,
      sandboxUserId: randomUUID(),
    });

    await request(app.getHttpServer()).get(`/api/events/${eventId}`).expect(404);
  });

  it('detail of an unknown event is 404', async () => {
    await request(app.getHttpServer()).get(`/api/events/${randomUUID()}`).expect(404);
  });

  it('a non-UUID id is 400', async () => {
    await request(app.getHttpServer()).get('/api/events/not-a-uuid').expect(400);
  });
});
