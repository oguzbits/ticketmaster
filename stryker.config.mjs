// Mutation tests of the pure domain code (see AGENTS.md, section 4). Slow, so it runs weekly and
// on demand (`pnpm mutation`), never in a hook.
export default {
  // pnpm does not hoist: core cannot find the runner by its own glob.
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts' },
  coverageAnalysis: 'perTest',
  mutate: ['apps/api/src/modules/*/domain/*.ts', 'apps/api/src/core/*.ts', '!**/*.spec.ts'],
  reporters: ['clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 90, low: 75, break: 90 },
  tempDirName: '.stryker-tmp',
};
