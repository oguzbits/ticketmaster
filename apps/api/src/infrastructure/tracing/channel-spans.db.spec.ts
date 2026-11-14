import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { openTestDatabase } from '../../testing/database.js';
import { openTestRedis } from '../../testing/redis.js';
import type { Redis } from '../redis/redis.module.js';
import { SPAN_ATTR, SPAN_NAME, withSpan } from './span.js';
import { startTestTracing } from './testing/index.js';

// The proof that the real drivers publish what the adapter expects (versions pinned in ADR 0007).
describe('driver spans of the real drivers', () => {
  const database = openTestDatabase();
  let redis: Redis;
  let shutdown: () => Promise<void>;
  beforeAll(async () => {
    redis = await openTestRedis();
  });
  afterEach(() => shutdown());
  afterAll(async () => {
    await redis.quit();
    await database.close();
  });

  it('finds one Drizzle query and one Redis command as children of the active span', async () => {
    const started = startTestTracing();
    shutdown = started.shutdown;

    await withSpan('request', async () => {
      await database.db.execute(sql`select ${'ada@example.com'}::text as probe`);
      await redis.ping();
    });

    const spans = started.exporter.getFinishedSpans();
    const request = spans.find((span) => span.name === 'request');
    const query = spans.find((span) => span.name === SPAN_NAME.DB_QUERY);
    const command = spans.find((span) => span.name === SPAN_NAME.REDIS_COMMAND);
    expect(query?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    expect(query?.attributes[SPAN_ATTR.DB_STATEMENT]).toContain('$1');
    expect(command?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    expect(command?.attributes[SPAN_ATTR.DB_OPERATION]).toBe('PING');
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('ada@example.com');
  });
});
