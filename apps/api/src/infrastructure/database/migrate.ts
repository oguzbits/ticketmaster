import path from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { pino } from 'pino';
import postgres from 'postgres';

import { loadEnv } from '../../config/config.module.js';
import * as schema from './schema.js';
import { seed } from './seed.js';

// Same path from `src/` and from `dist/`: three levels up is `apps/api`.
const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, '../../../drizzle');

const logger = pino();
// One connection: migrations run in order and DDL does not need a pool.
const client = postgres(loadEnv().DATABASE_URL, { max: 1 });
try {
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  logger.info('migrations applied');
  await seed(db);
  logger.info('seed applied');
} finally {
  await client.end();
}
