import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

const REPLICAS = 2;
const WARM_UP_REQUESTS = 20;
/** How long the app is watched while one replica stops, and how often it is asked. */
const WATCH_MS = 10_000;
const STEP_MS = 200;

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs in the project that waits for every other spec: it stops one of the api replicas of the
// stack. The Compose project name comes from the environment `scripts/e2e.mjs` sets.
test('the app keeps answering when one api replica stops', async ({ page, request }) => {
  const replicas = execFileSync('docker', ['compose', 'ps', '-q', 'api'], { encoding: 'utf8' })
    .split('\n')
    .filter((id) => id !== '');
  expect(replicas).toHaveLength(REPLICAS);
  const [stopped] = replicas;
  if (stopped === undefined) throw new Error('no api replica');
  for (let n = 0; n < WARM_UP_REQUESTS; n++) {
    expect((await request.get('/health/ready')).status()).toBe(200);
  }

  const stopping = run('docker', ['stop', stopped]);
  const statuses: number[] = [];
  try {
    const watchUntil = Date.now() + WATCH_MS;
    let stopDone = false;
    void stopping.then(() => (stopDone = true));
    while (!stopDone || Date.now() < watchUntil) {
      statuses.push((await request.get('/health/ready')).status());
      await sleep(STEP_MS);
    }
    expect(statuses.filter((status) => status !== 200)).toEqual([]);

    await page.goto('/events');
    await expect(page.getByRole('link', { name: 'Jazz Gala (optimistic)' })).toBeVisible();
  } finally {
    await stopping;
    await run('docker', ['start', stopped]);
  }
});
