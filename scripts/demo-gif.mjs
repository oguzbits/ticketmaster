/**
 * Records docs/demo.gif: two browser windows on the same event, a viewer who is not signed in (left)
 * and a customer who holds a seat and pays (right). The viewer's map follows within a second.
 * Needs the running Compose stack (`docker compose up --build`, web on port 8080) and ffmpeg.
 *
 *   pnpm demo:gif
 *
 * The demo login allows five a minute and address; this script uses one.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Playwright is a dependency of apps/web, not of the root.
const require = createRequire(path.join(import.meta.dirname, '../apps/web/package.json'));
const { chromium } = require('@playwright/test');

const BASE_URL = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:8080';
const EVENT = 'Jazz Gala (optimistic)';
const SIZE = { width: 1024, height: 720 }; // desktop layout: the map beside the booking panel
const OUTPUT = path.join(import.meta.dirname, '../docs/demo.gif');
const PAUSE_MS = 1800;
const PAYMENT_ATTEMPTS = 5; // the fake provider fails one payment in ten

const videos = mkdtempSync(path.join(tmpdir(), 'demo-gif-'));
const browser = await chromium.launch();

async function windowOf(name) {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: SIZE,
    recordVideo: { dir: path.join(videos, name), size: SIZE },
  });
  return { context, page: await context.newPage() };
}

async function openEvent(page) {
  await page.goto('/events');
  await page.getByRole('link', { name: EVENT }).click();
  await page.getByRole('heading', { level: 1, name: EVENT }).waitFor();
}

try {
  const viewer = await windowOf('viewer');
  const buyer = await windowOf('buyer');

  await buyer.page.goto('/');
  await buyer.page.getByRole('button', { name: 'customer' }).click();
  await buyer.page.getByText('Signed in as customer').waitFor();
  const streamOpened = viewer.page.waitForResponse((r) => r.url().includes('/seats/stream'));
  await Promise.all([openEvent(viewer.page), openEvent(buyer.page)]);
  await streamOpened;
  await buyer.page.waitForTimeout(PAUSE_MS);

  await buyer.page
    .getByRole('button', { name: /, available$/ })
    .first()
    .click();
  await buyer.page.getByRole('timer').waitFor();
  await buyer.page.waitForTimeout(PAUSE_MS);

  for (let attempt = 1; attempt <= PAYMENT_ATTEMPTS; attempt += 1) {
    await buyer.page.getByRole('button', { name: 'Pay now' }).click();
    const confirmed = await buyer.page
      .getByText('Booking confirmed.')
      .waitFor({ timeout: 5000 })
      .then(
        () => true,
        () => false
      );
    if (confirmed) break;
    if (attempt === PAYMENT_ATTEMPTS) throw new Error('The payment failed every time');
  }
  await buyer.page.waitForTimeout(PAUSE_MS * 1.5);

  await viewer.context.close();
  await buyer.context.close();

  const first = (name) => {
    const [file] = readdirSync(path.join(videos, name));
    return path.join(videos, name, file);
  };
  const filter =
    '[0:v][1:v]hstack=inputs=2,fps=8,scale=1280:-1:flags=lanczos,split[a][b];' +
    '[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';
  mkdirSync(path.dirname(OUTPUT), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      first('viewer'),
      '-i',
      first('buyer'),
      '-filter_complex',
      filter,
      '-loop',
      '0',
      OUTPUT,
    ],
    { stdio: 'inherit' }
  );
  console.log(`wrote ${OUTPUT}`);
} finally {
  await browser.close();
  rmSync(videos, { recursive: true, force: true });
}
