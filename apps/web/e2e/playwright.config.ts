import { defineConfig, devices } from '@playwright/test';

// Runs against the Compose stack (`pnpm e2e` starts it). One worker, in order: the specs share one
// demo-login session and the API allows five demo logins per minute and address.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:8080', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
