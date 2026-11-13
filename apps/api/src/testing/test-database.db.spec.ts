import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { openTestDatabase } from './database.js';
import { TEST_DATABASE_NAME } from './test-database-url.js';

describe('database of the db specs', () => {
  const database = openTestDatabase();
  afterAll(() => database.close());

  it('is the dedicated test database, never the development one', async () => {
    const [row] = await database.db.execute<{ name: string }>(
      sql`select current_database() as name`
    );

    expect(row?.name).toBe(TEST_DATABASE_NAME);
  });
});
