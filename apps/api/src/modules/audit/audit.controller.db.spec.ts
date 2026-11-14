import { randomUUID } from 'node:crypto';

import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  type AuditAction,
  type AuditLogPage,
  AuditLogPageSchema,
  ROLE,
} from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { CLOCK } from '../../core/clock.js';
import { openTestDatabase } from '../../testing/database.js';
import { fakeTokenVerifier, randomClientAddress } from '../../testing/http.js';
import { SPEC_NOW } from '../../testing/time.js';
import { TOKEN_VERIFIER } from '../auth/index.js';
import { AuditService } from './audit.service.js';

const TOKENS = {
  admin: { id: randomUUID(), roles: [ROLE.ADMIN] },
  customer: { id: randomUUID(), roles: [ROLE.CUSTOMER] },
  organizer: { id: randomUUID(), roles: [ROLE.ORGANIZER] },
};
type Caller = keyof typeof TOKENS;
const ROWS = 120;
const DEFAULT_PAGE = 50;
const LAST_PAGE = ROWS - 2 * DEFAULT_PAGE;

describe('GET /audit-log', () => {
  const database = openTestDatabase();
  const { db } = database;
  let app: INestApplication;
  let audit: AuditService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(fakeTokenVerifier(TOKENS))
      .overrideProvider(CLOCK)
      .useValue({ now: () => SPEC_NOW })
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    audit = app.get(AuditService);
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  // Other specs write to the shared table: every test reads only the rows of its own actor.
  const write = (
    actorId: string,
    count: number,
    action: AuditAction = AUDIT_ACTION.EVENT_CREATED
  ) =>
    db.transaction(async (tx) => {
      for (let i = 0; i < count; i++) {
        await audit.record(tx, {
          actorId,
          action,
          subjectType: AUDIT_SUBJECT.EVENT,
          subjectId: randomUUID(),
          requestId: `req-${i}`,
        });
      }
    });
  const get = (query: string, caller?: Caller) => {
    const pending = request(app.getHttpServer())
      .get(`/api/audit-log${query}`)
      .set('X-Forwarded-For', randomClientAddress());
    return caller === undefined ? pending : pending.set('Authorization', `Bearer ${caller}`);
  };
  const page = async (query: string): Promise<AuditLogPage> =>
    AuditLogPageSchema.parse((await get(query, 'admin').expect(200)).body);
  const ids = (p: AuditLogPage) => p.items.map((item) => item.id);
  /** Follows the cursors from `first` to the end; returns every page. */
  async function allPages(base: string, first: AuditLogPage): Promise<AuditLogPage[]> {
    const pages = [first];
    for (let last = first; last.nextCursor !== null;) {
      last = await page(`${base}&cursor=${last.nextCursor}`);
      pages.push(last);
    }
    return pages;
  }

  it('refuses no token with 401', async () => {
    await get('').expect(401);
  });

  it('refuses a customer with 403', async () => {
    await get('', 'customer').expect(403);
  });

  it('refuses an organizer with 403', async () => {
    await get('', 'organizer').expect(403);
  });

  it('answers an admin with 200', async () => {
    await get('', 'admin').expect(200);
  });

  it('pages newest first and yields every row exactly once', async () => {
    const actorId = randomUUID();
    await write(actorId, ROWS);
    const base = `?actorId=${actorId}`;

    const first = await page(base);
    const pages = await allPages(base, first);

    expect(first.items).toHaveLength(DEFAULT_PAGE);
    expect(first.nextCursor).toBe(first.items.at(-1)?.id);
    expect(pages.map((p) => p.items.length)).toEqual([DEFAULT_PAGE, DEFAULT_PAGE, LAST_PAGE]);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    const all = pages.flatMap(ids);
    expect(new Set(all).size).toBe(ROWS);
    expect(all).toEqual([...all].sort((a, b) => Number(b) - Number(a)));
  });

  it('keeps the pages stable when newer rows arrive between two reads', async () => {
    const actorId = randomUUID();
    await write(actorId, ROWS);
    const base = `?actorId=${actorId}`;
    const first = await page(base);

    await write(actorId, 5);
    const rest = await allPages(base, await page(`${base}&cursor=${first.nextCursor}`));

    const all = [...ids(first), ...rest.flatMap(ids)];
    expect(all).toHaveLength(ROWS);
    expect(new Set(all).size).toBe(ROWS);
  });

  it('filters by action and by actor', async () => {
    const actorId = randomUUID();
    await write(actorId, 2, AUDIT_ACTION.EVENT_CREATED);
    await write(actorId, 3, AUDIT_ACTION.BOOKING_PAID);

    const byActor = await page(`?actorId=${actorId}`);
    const byBoth = await page(`?actorId=${actorId}&action=${AUDIT_ACTION.BOOKING_PAID}`);
    const byAction = await page(`?action=${AUDIT_ACTION.BOOKING_PAID}`);

    expect(byActor.items).toHaveLength(5);
    expect(byBoth.items).toHaveLength(3);
    expect(byBoth.items.every((item) => item.action === AUDIT_ACTION.BOOKING_PAID)).toBe(true);
    expect(byAction.items.length).toBeGreaterThanOrEqual(3);
    expect(byAction.items.every((item) => item.action === AUDIT_ACTION.BOOKING_PAID)).toBe(true);
  });

  it('answers an empty page for an actor with no rows', async () => {
    expect(await page(`?actorId=${randomUUID()}`)).toEqual({ items: [], nextCursor: null });
  });

  it.each(['?cursor=abc', '?limit=0', '?limit=101', '?actorId=abc', '?action=UNKNOWN'])(
    'answers 400 for the query %s',
    async (query) => {
      await get(query, 'admin').expect(400);
    }
  );
});
