import path from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';

import { migrationDatabaseUrl, parseEnv } from '../config/env.js';
import { ensureRuntimeRole } from '../infrastructure/database/runtime-role.js';
import { TEST_DATABASE_NAME, testDatabaseUrl } from './test-database-url.js';

const MAINTENANCE_DATABASE = 'postgres';
// Same path from `src/testing`: two levels up is `apps/api`.
const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, '../../drizzle');

/**
 * Vitest global setup of the `db` project: a fresh, migrated `app_test` on the local server, so the
 * specs never write into the development database. `vitest.config.ts` points DATABASE_URL at it.
 */
export default async function setup(project: TestProject): Promise<void> {
  const env = parseEnv({ ...project.config.env });
  const url = new URL(env.DATABASE_URL);
  // Fail fast: this setup drops a database, so it only ever touches the test one.
  if (url.pathname !== `/${TEST_DATABASE_NAME}`) {
    throw new Error(`db specs must run against ${TEST_DATABASE_NAME}`);
  }

  // The owner creates the database, the role and the schema; the specs run as the runtime role.
  const ownerUrl = migrationDatabaseUrl(env);
  const maintenanceUrl = new URL(ownerUrl);
  maintenanceUrl.pathname = `/${MAINTENANCE_DATABASE}`;
  const admin = postgres(maintenanceUrl.toString(), { max: 1 });
  try {
    // Identifiers cannot be parameters; the name is the constant above.
    await admin.unsafe(`drop database if exists ${TEST_DATABASE_NAME} with (force)`);
    await admin.unsafe(`create database ${TEST_DATABASE_NAME}`);
    await ensureRuntimeRole(admin, url.password);
  } finally {
    await admin.end();
  }

  const client = postgres(testDatabaseUrl(ownerUrl), { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }
}
