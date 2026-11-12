import path from 'node:path';

import { configDefaults, defineConfig } from 'vitest/config';

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
        },
      },
      project('hooks', './.claude/hooks'),
      project('scripts', './scripts'),
    ],
  },
});
