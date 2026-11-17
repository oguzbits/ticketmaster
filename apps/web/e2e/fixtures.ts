import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test as base,
} from '@playwright/test';

/** Where the web app keeps its session (`SessionStore`). */
export const SESSION_KEY = 'session';

export type DemoRole = 'customer' | 'organizer' | 'admin';

/** The start page, one click on the role, then the event list. */
export async function loginAs(page: Page, role: DemoRole): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: role }).click();
  await expect(page.getByText(`Signed in as ${role}`)).toBeVisible();
}

/** From the event list to the seat map of the event whose name matches. */
export async function openEvent(page: Page, name: string): Promise<void> {
  await page.goto('/events');
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

async function captureSession(
  browser: Browser,
  baseURL: string | undefined,
  role: DemoRole
): Promise<string> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await loginAs(page, role);
  const session = await page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY);
  await context.close();
  if (session === null) throw new Error('The demo login stored no session');
  return session;
}

async function withSession(
  browser: Browser,
  baseURL: string | undefined,
  session: string,
  use: (context: BrowserContext) => Promise<void>
): Promise<void> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(([key, value]) => sessionStorage.setItem(key, value), [
    SESSION_KEY,
    session,
  ] as const);
  await use(context);
  await context.close();
}

/**
 * The demo login allows five per minute and address, so specs share one login per role across the
 * worker run instead of hitting the rate limit.
 */
export const test = base.extend<
  { customerContext: BrowserContext; adminContext: BrowserContext },
  { customerSession: string; adminSession: string }
>({
  customerSession: [
    async ({ browser }, use, workerInfo) => {
      await use(await captureSession(browser, workerInfo.project.use.baseURL, 'customer'));
    },
    { scope: 'worker' },
  ],
  adminSession: [
    async ({ browser }, use, workerInfo) => {
      await use(await captureSession(browser, workerInfo.project.use.baseURL, 'admin'));
    },
    { scope: 'worker' },
  ],
  customerContext: async ({ browser, baseURL, customerSession }, use) => {
    await withSession(browser, baseURL, customerSession, use);
  },
  adminContext: async ({ browser, baseURL, adminSession }, use) => {
    await withSession(browser, baseURL, adminSession, use);
  },
});

export { expect };
