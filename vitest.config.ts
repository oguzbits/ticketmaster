import path from 'node:path';

import { configDefaults, defineConfig } from 'vitest/config';

import { parseEnv } from './apps/api/src/config/env.js';
import { testDatabaseUrl } from './apps/api/src/testing/test-database-url.js';

const setupFiles = [path.resolve(import.meta.dirname, 'vitest.setup.ts')];
const DB_SPECS = '**/*.db.spec.ts';
const project = (name: string, root: string) => ({
  test: { name, root, environment: 'node', setupFiles },
});
// Tests that need Postgres or Redis run only through `pnpm test:db`.
const offlineProject = (name: string, root: string) => ({
  test: { ...project(name, root).test, exclude: [...configDefaults.exclude, DB_SPECS] },
});

// apps/web is not listed: Angular compiles its tests itself (`ng test`, run by `pnpm test`).
export default defineConfig({
  test: {
    projects: [
      project('shared', './packages/shared'),
      offlineProject('api', './apps/api'),
      offlineProject('worker', './apps/worker'),
      {
        test: {
          ...project('db', '.').test,
          include: ['apps/{api,worker}/src/**/*.db.spec.ts'],
          // Own database: the specs write events and bookings that must not reach the dev data.
          globalSetup: ['./apps/api/src/testing/db-global-setup.ts'],
          env: { DATABASE_URL: testDatabaseUrl(parseEnv(process.env).DATABASE_URL) },
        },
      },
      project('hooks', './.claude/hooks'),
      project('scripts', './scripts'),
    ],
  },
});
