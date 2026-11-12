import path from 'node:path';

import { defineConfig } from 'vitest/config';

const setupFiles = [path.resolve(import.meta.dirname, 'vitest.setup.ts')];
const project = (name: string, root: string) => ({
  test: { name, root, environment: 'node', setupFiles },
});

// apps/web is not listed: Angular compiles its tests itself (`ng test`, run by `pnpm test`).
export default defineConfig({
  test: {
    projects: [
      project('shared', './packages/shared'),
      project('api', './apps/api'),
      project('worker', './apps/worker'),
      project('hooks', './.claude/hooks'),
      project('scripts', './scripts'),
    ],
  },
});
