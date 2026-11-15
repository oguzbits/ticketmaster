import path from 'node:path';

import { configDefaults, defineConfig } from 'vitest/config';

// Test run of `pnpm mutation`: the offline API specs only (the domain code is tested there), so a
// mutant never waits for PostgreSQL or Redis.
export default defineConfig({
  test: {
    root: './apps/api',
    environment: 'node',
    setupFiles: [path.resolve(import.meta.dirname, 'vitest.setup.ts')],
    exclude: [...configDefaults.exclude, '**/*.db.spec.ts'],
  },
});
