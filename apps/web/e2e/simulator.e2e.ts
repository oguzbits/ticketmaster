import { BOOKING_STRATEGY } from '@app/shared';

import { expect, loginAs, test } from './fixtures';

/** The worker finishes a run this small within seconds; the margin covers a cold stack. */
const RUN_MS = 60_000;

test('an admin runs a pessimistic simulation and sees no seat sold twice', async ({ page }) => {
  await loginAs(page, 'admin');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Simulator' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Rush simulator' })).toBeVisible();
  await expect(page.getByText('No finished runs yet')).toBeVisible();

  await page.getByLabel('Buyers').fill('100');
  await page.getByLabel('Seats').fill('20');
  await page.getByLabel('Strategy').selectOption(BOOKING_STRATEGY.PESSIMISTIC);
  await page.getByRole('button', { name: 'Start run' }).click();

  await expect(page.getByText('Status: FINISHED')).toBeVisible({ timeout: RUN_MS });
  await expect(page.getByText('0, no seat sold twice')).toBeVisible();

  const rows = page.getByRole('region', { name: 'Comparison' }).getByRole('row');
  await expect(rows).toHaveCount(2); // header and the one finished run
  await expect(rows.nth(1)).toContainText(BOOKING_STRATEGY.PESSIMISTIC);
  await expect(rows.nth(1)).not.toContainText('sold twice');
});
