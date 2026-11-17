import { randomUUID } from 'node:crypto';

import {
  BOOKING_STRATEGY,
  BookingSchema,
  IDEMPOTENCY_KEY_HEADER,
  ROLE,
  TicketDownloadSchema,
} from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { APP_CONFIG, loadEnv } from '../../config/config.module.js';
import { CLOCK } from '../../core/clock.js';
import { bookings } from '../../infrastructure/database/schema.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { SPEC_NOW } from '../../testing/time.js';
import { TOKEN_VERIFIER } from '../auth/index.js';
import { PRESIGNED_TICKET_TTL_SECONDS, TICKET_STORE } from './domain/ticket.js';
import { FakeTicketStore } from './testing/fake-ticket-store.js';

const ALICE = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const BOB = { id: randomUUID(), roles: [ROLE.CUSTOMER] };
const ORGANIZER = { id: randomUUID(), roles: [ROLE.ORGANIZER] };
const ADMIN = { id: randomUUID(), roles: [ROLE.ADMIN] };
const TOKENS = { alice: ALICE, bob: BOB, organizer: ORGANIZER, admin: ADMIN };
type Caller = keyof typeof TOKENS;

const PDF = Buffer.from('%PDF-1.3 the ticket of alice \u0000ÿ', 'latin1');

describe('GET /bookings/:id/ticket', () => {
  const database = openTestDatabase();
  const { db } = database;
  const store = new FakeTicketStore();
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue({ now: () => SPEC_NOW })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier(TOKENS))
      // Every payment succeeds: the tickets belong to confirmed bookings.
      .overrideProvider(APP_CONFIG)
      .useValue({ ...loadEnv(), PAYMENT_FAILURE_RATE: 0 })
      .overrideProvider(TICKET_STORE)
      .useValue(store)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  const call = (method: 'get' | 'post', path: string, caller?: Caller) => {
    const server = request(app.getHttpServer());
    const pending = (method === 'get' ? server.get(`/api${path}`) : server.post(`/api${path}`)).set(
      'X-Forwarded-For',
      randomClientAddress()
    );
    return caller === undefined ? pending : pending.set('Authorization', `Bearer ${caller}`);
  };

  const ticket = (bookingId: string, caller?: Caller) =>
    call('get', `/bookings/${bookingId}/ticket`, caller);

  /** Alice's confirmed booking; the worker's part is played by the two lines at the end. */
  async function confirmedBooking(options: { ticketStored: boolean }): Promise<string> {
    const { eventId, seatIds } = await createTestEvent(db, {
      strategy: BOOKING_STRATEGY.PESSIMISTIC,
      seats: 1,
    });
    const held = await call('post', '/bookings', 'alice')
      .send({ eventId, seatId: seatIds[0] })
      .expect(201);
    const { id } = BookingSchema.parse(held.body);
    await call('post', `/bookings/${id}/payment`, 'alice')
      .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
      .expect(200);
    if (options.ticketStored) {
      await store.put(id, PDF);
      await db.update(bookings).set({ ticketReadyAt: SPEC_NOW }).where(eq(bookings.id, id));
    }
    return id;
  }

  it('returns a short-lived presigned download URL to the owner', async () => {
    const id = await confirmedBooking({ ticketStored: true });

    const response = await ticket(id, 'alice').expect(200);

    const payload = TicketDownloadSchema.parse(response.body);
    expect(payload.url).toBe(
      `https://storage.test/tickets/${id}.pdf?expiresIn=${PRESIGNED_TICKET_TTL_SECONDS}`
    );
    expect(payload.expiresAt).toBe(
      new Date(SPEC_NOW.getTime() + PRESIGNED_TICKET_TTL_SECONDS * 1000).toISOString()
    );
  });

  it('answers 403 for the booking of another customer, 403 for an organizer and an admin, 401 without a token', async () => {
    const id = await confirmedBooking({ ticketStored: true });

    await ticket(id, 'bob').expect(403);
    await ticket(id, 'organizer').expect(403);
    await ticket(id, 'admin').expect(403);
    await ticket(id).expect(401);
  });

  it('answers 404 for an unknown booking and 400 for an ID that is not a UUID', async () => {
    await ticket(randomUUID(), 'alice').expect(404);
    await ticket('not-a-uuid', 'alice').expect(400);
  });

  it('answers 404 until the worker has stored the ticket', async () => {
    const id = await confirmedBooking({ ticketStored: false });

    await ticket(id, 'alice').expect(404);
  });

  it('answers 404 for a cancelled booking although its PDF still exists', async () => {
    const id = await confirmedBooking({ ticketStored: true });
    await call('post', `/bookings/${id}/cancel`, 'alice').expect(200);
    expect(await store.get(id)).not.toBeNull();

    await ticket(id, 'alice').expect(404);
  });
});
