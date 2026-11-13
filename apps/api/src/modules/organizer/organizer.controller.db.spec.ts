import { randomUUID } from 'node:crypto';

import {
  BOOKING_STATUS,
  BOOKING_STRATEGY,
  type BookingStatus,
  OrganizerEventListResponseSchema,
  ROLE,
  VenueListResponseSchema,
} from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { bookings, venues, venueSeats } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { SPEC_NOW } from '../../testing/time.js';
import { TOKEN_VERIFIER } from '../auth/index.js';

const ORGANIZER_A = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const ORGANIZER_B = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const CUSTOMER = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const TOKENS = { a: ORGANIZER_A, b: ORGANIZER_B, customer: CUSTOMER };
type Caller = keyof typeof TOKENS;

describe('organizer endpoints', () => {
  const database = openTestDatabase();
  const { db } = database;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier(TOKENS))
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  const get = (path: string, caller?: Caller) => {
    const pending = request(app.getHttpServer())
      .get(`/api${path}`)
      .set('X-Forwarded-For', randomClientAddress());
    return caller === undefined ? pending : pending.set('Authorization', `Bearer ${caller}`);
  };

  describe('access', () => {
    it.each(['/venues', '/organizer/events'])(
      'GET %s: no token is 401, a customer is 403',
      async (path) => {
        await get(path).expect(401);
        await get(path, 'customer').expect(403);
      }
    );
  });

  describe('venues', () => {
    it('lists the venues with their seat count', async () => {
      const venueId = randomUUID();
      await db.insert(venues).values({ id: venueId, name: `venue ${venueId}` });
      await db.insert(venueSeats).values([
        { venueId, section: 'A', row: 1, number: 1 },
        { venueId, section: 'A', row: 1, number: 2 },
        { venueId, section: 'B', row: 1, number: 1 },
      ]);

      const response = await get('/venues', 'a').expect(200);

      const listed = VenueListResponseSchema.parse(response.body);
      expect(listed.find(({ id }) => id === venueId)).toEqual({
        id: venueId,
        name: `venue ${venueId}`,
        seatCount: 3,
      });
    });
  });

  describe('own events', () => {
    const ownEvents = async (caller: Caller) =>
      OrganizerEventListResponseSchema.parse(
        (await get('/organizer/events', caller).expect(200)).body
      );

    it('lists only the events the caller owns', async () => {
      const mine = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 1,
        ownerId: ORGANIZER_A.id,
      });
      const theirs = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 1,
        ownerId: ORGANIZER_B.id,
      });

      const ids = (await ownEvents('a')).map(({ id }) => id);

      expect(ids).toContain(mine.eventId);
      expect(ids).not.toContain(theirs.eventId);
    });

    it('counts sold and held seats from the bookings, not expired or cancelled ones', async () => {
      const { eventId, seatIds } = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 6,
        ownerId: ORGANIZER_A.id,
      });
      const statuses: BookingStatus[] = [
        BOOKING_STATUS.HELD,
        BOOKING_STATUS.HELD,
        BOOKING_STATUS.CONFIRMED,
        BOOKING_STATUS.EXPIRED,
        BOOKING_STATUS.CANCELLED,
      ];
      await db.insert(bookings).values(
        statuses.map((status, index) => ({
          eventId,
          seatId: seatIds[index] ?? '',
          userId: CUSTOMER.id,
          strategy: BOOKING_STRATEGY.PESSIMISTIC,
          status,
          holdExpiresAt: SPEC_NOW,
        }))
      );

      const event = (await ownEvents('a')).find(({ id }) => id === eventId);

      expect(event).toMatchObject({ seatCount: 6, soldCount: 1, heldCount: 2 });
      expect(event?.utilization).toBeCloseTo(1 / 6);
    });

    it('reports an event without seats as 0 utilization', async () => {
      const { eventId } = await createTestEvent(db, {
        strategy: BOOKING_STRATEGY.PESSIMISTIC,
        seats: 0,
        ownerId: ORGANIZER_A.id,
      });

      const event = (await ownEvents('a')).find(({ id }) => id === eventId);

      expect(event).toMatchObject({ seatCount: 0, utilization: 0 });
    });
  });
});
