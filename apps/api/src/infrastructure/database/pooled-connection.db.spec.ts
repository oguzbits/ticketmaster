import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';

const CLIENT_CONNECTIONS = 10;
const QUERIES = 100;

// Through PgBouncer (`pnpm test:db:pooled`) this fails when `max_prepared_statements` is off: a
// named statement is prepared on one server connection and the next transaction may get another.
describe('database connection', () => {
  const client = postgres(loadEnv().DATABASE_URL, { max: CLIENT_CONNECTIONS, prepare: true });
  afterAll(() => client.end());

  it('runs named prepared statements on whichever server connection a transaction gets', async () => {
    const results = await Promise.all(
      Array.from({ length: QUERIES }, (_, n) =>
        client.begin(async (tx) => (await tx`select ${n}::int as n`)[0]?.['n'])
      )
    );

    expect(results).toEqual(Array.from({ length: QUERIES }, (_, n) => n));
  });
});
