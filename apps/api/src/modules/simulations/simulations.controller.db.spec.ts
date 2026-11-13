import { randomUUID } from 'node:crypto';

import {
  BOOKING_STRATEGY,
  EventListResponseSchema,
  ROLE,
  SIMULATION_LIMITS,
  SIMULATION_STATUS,
  SIMULATION_STREAM_KEY,
  SimulationListResponseSchema,
  SimulationRunSchema,
  type SimulationStatus,
} from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { and, eq, gte, lte } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { CLOCK } from '../../core/clock.js';
import { events, seats, simulationRuns } from '../../infrastructure/database/schema.js';
import { RATE_LIMIT } from '../../infrastructure/rate-limit/rate-limit.decorator.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { createTestEvent, openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { SPEC_NOW } from '../../testing/time.js';
import { TOKEN_VERIFIER } from '../auth/index.js';

const ADMIN = { id: randomUUID(), roles: [ROLE.ADMIN] };
const TOKENS = {
  admin: ADMIN,
  customer: { id: randomUUID(), roles: [ROLE.CUSTOMER] },
  organizer: { id: randomUUID(), roles: [ROLE.ORGANIZER] },
};
type Caller = keyof typeof TOKENS;
const STRATEGY = BOOKING_STRATEGY.PESSIMISTIC;
const BODY = { buyers: 10, seats: 5, strategy: STRATEGY };
const HOUR_MS = 60 * 60 * 1000;
// The cap counts the runs of the whole table inside a window around the clock, so this file's
// runs sit at SPEC_NOW and are cleared before every test; the other specs use other days.
const WINDOW_START = new Date(SPEC_NOW.getTime() - HOUR_MS);
const WINDOW_END = new Date(SPEC_NOW.getTime() + HOUR_MS);
// Later than any run another spec stores, so these are the latest finished runs of the table.
const FAR_FUTURE = new Date('2300-01-01T00:00:00.000Z');

describe('simulation endpoints', () => {
  const database = openTestDatabase();
  const { db } = database;
  let app: INestApplication;
  let redis: Redis;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier(TOKENS))
      .overrideProvider(CLOCK)
      .useValue({ now: () => SPEC_NOW })
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    redis = app.get(REDIS);
    // A venue to host the sandbox events (a fresh test database has none).
    await createTestEvent(db, { strategy: STRATEGY, seats: 0 });
  });
  beforeEach(async () => {
    await db
      .delete(simulationRuns)
      .where(
        and(gte(simulationRuns.startedAt, WINDOW_START), lte(simulationRuns.startedAt, WINDOW_END))
      );
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  const call = (method: 'get' | 'post', path: string, caller?: Caller) => {
    const agent = request(app.getHttpServer());
    const pending = agent[method](`/api${path}`).set('X-Forwarded-For', randomClientAddress());
    return caller === undefined ? pending : pending.set('Authorization', `Bearer ${caller}`);
  };
  const start = (body: object, caller?: Caller) => call('post', '/simulations', caller).send(body);

  describe('POST /simulations', () => {
    it('refuses no token with 401, a customer and an organizer with 403, and writes nothing', async () => {
      await start(BODY).expect(401);
      await start(BODY, 'customer').expect(403);
      await start(BODY, 'organizer').expect(403);

      expect(
        await db
          .select()
          .from(simulationRuns)
          .where(eq(simulationRuns.startedBy, TOKENS.customer.id))
      ).toEqual([]);
      expect(await db.select().from(events).where(eq(events.ownerId, TOKENS.customer.id))).toEqual(
        []
      );
    });

    it.each([
      { buyers: 0 },
      { buyers: SIMULATION_LIMITS.BUYERS_MAX + 1 },
      { seats: 0 },
      { seats: SIMULATION_LIMITS.SEATS_MAX + 1 },
      { buyers: 1.5 },
      { strategy: 'unknown' },
    ])('answers 400 for the body %j', async (override) => {
      await start({ ...BODY, ...override }, 'admin').expect(400);
    });

    it('applies the defaults to a body with only a strategy', async () => {
      const response = await start({ strategy: STRATEGY }, 'admin').expect(201);

      expect(SimulationRunSchema.parse(response.body)).toMatchObject({
        buyers: SIMULATION_LIMITS.BUYERS_DEFAULT,
        seats: SIMULATION_LIMITS.SEATS_DEFAULT,
        strategy: STRATEGY,
        status: SIMULATION_STATUS.QUEUED,
      });
    });

    it('creates M seats on a private event of the admin, one QUEUED run and one queue entry', async () => {
      const response = await start(BODY, 'admin').expect(201);

      const run = SimulationRunSchema.parse(response.body);
      expect(run).toMatchObject({ ...BODY, status: SIMULATION_STATUS.QUEUED, metrics: null });
      const [event] = await db.select().from(events).where(eq(events.id, run.eventId));
      expect(event).toMatchObject({
        ownerId: ADMIN.id,
        sandboxUserId: ADMIN.id,
        strategy: STRATEGY,
      });
      expect(await db.select().from(seats).where(eq(seats.eventId, run.eventId))).toHaveLength(
        BODY.seats
      );
      const [row] = await db.select().from(simulationRuns).where(eq(simulationRuns.id, run.id));
      expect(row).toMatchObject({ startedBy: ADMIN.id, status: SIMULATION_STATUS.QUEUED });
      const entries = await redis.xRange(SIMULATION_STREAM_KEY, '-', '+');
      expect(entries?.filter(({ message }) => message.runId === run.id)).toHaveLength(1);
      const listed = await call('get', '/events').expect(200);
      expect(EventListResponseSchema.parse(listed.body).map(({ id }) => id)).not.toContain(
        run.eventId
      );
    });

    it('answers 429 over the SIMULATION limit, counted before the body is read', async () => {
      const address = randomClientAddress();
      // An invalid body is refused with 400 after the rate limit has counted the call.
      const attempt = () => start({}, 'admin').set('X-Forwarded-For', address);

      for (let n = 0; n < RATE_LIMIT.SIMULATION.limit; n += 1) await attempt().expect(400);
      const refused = await attempt().expect(429);

      expect(refused.headers['retry-after']).toBeDefined();
    });
  });

  describe('GET /simulations', () => {
    it('refuses no token with 401, a customer and an organizer with 403', async () => {
      await call('get', '/simulations').expect(401);
      await call('get', '/simulations', 'customer').expect(403);
      await call('get', '/simulations', 'organizer').expect(403);
    });

    it('lists only the 20 latest finished runs, newest first', async () => {
      const finishedAt = (n: number) => new Date(FAR_FUTURE.getTime() + n * 1000);
      const ids: string[] = [];
      // 22 finished runs, one running and one failed: the list takes only finished runs, 20 of them.
      for (let n = 0; n < 22; n += 1) {
        ids.push(await seedRun(SIMULATION_STATUS.FINISHED, finishedAt(n)));
      }
      await seedRun(SIMULATION_STATUS.RUNNING, null);
      await seedRun(SIMULATION_STATUS.FAILED, finishedAt(100));

      const response = await call('get', '/simulations', 'admin').expect(200);

      const listed = SimulationListResponseSchema.parse(response.body);
      expect(listed.map(({ id }) => id)).toEqual(ids.slice(2).toReversed());
    });
  });

  describe('GET /simulations/:id', () => {
    it('is public: a run by its ID, 404 for an unknown one, 400 for a malformed one', async () => {
      const id = await seedRun(SIMULATION_STATUS.FINISHED, new Date(SPEC_NOW));

      const response = await call('get', `/simulations/${id}`).expect(200);
      await call('get', `/simulations/${randomUUID()}`).expect(404);
      await call('get', '/simulations/not-a-uuid').expect(400);

      expect(SimulationRunSchema.parse(response.body)).toMatchObject({
        id,
        status: SIMULATION_STATUS.FINISHED,
      });
    });
  });

  async function seedRun(status: SimulationStatus, finishedAt: Date | null) {
    const { eventId } = await createTestEvent(db, { strategy: STRATEGY, seats: 0 });
    const [row] = await db
      .insert(simulationRuns)
      .values({
        eventId,
        strategy: STRATEGY,
        buyers: 1,
        seats: 1,
        status,
        startedBy: randomUUID(),
        // Inside this file's window only while it is active: finished runs must not feed the cap.
        startedAt: SPEC_NOW,
        finishedAt,
      })
      .returning({ id: simulationRuns.id });
    if (row === undefined) throw new Error('run insert returned no row');
    return row.id;
  }
});
