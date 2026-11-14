import { type BrowserContext, expect, type Page, test as base } from '@playwright/test';

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

/**
 * The demo login allows five per minute and address, so the specs that only need a signed-in
 * customer share one login per run instead of making their own.
 */
export const test = base.extend<{ customerContext: BrowserContext }, { customerSession: string }>({
  customerSession: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL });
      const page = await context.newPage();
      await loginAs(page, 'customer');
      const session = await page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY);
      await context.close();
      if (session === null) throw new Error('The demo login stored no session');
      await use(session);
    },
    { scope: 'worker' },
  ],
  customerContext: async ({ browser, baseURL, customerSession }, use) => {
    const context = await browser.newContext({ baseURL });
    await context.addInitScript(([key, value]) => sessionStorage.setItem(key, value), [
      SESSION_KEY,
      customerSession,
    ] as const);
    await use(context);
    await context.close();
  },
});

export { expect };
