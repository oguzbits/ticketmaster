import { expect, loginAs, openEvent, test } from './fixtures';

test('a customer logs in, holds a seat, pays and finds the confirmed booking', async ({ page }) => {
  await loginAs(page, 'customer');
  await openEvent(page, 'Symphony Evening (pessimistic)');

  await page
    .getByRole('button', { name: /, available$/ })
    .first()
    .click();
  await expect(page.getByRole('timer')).toContainText('Hold expires in');

  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByText('Booking confirmed.')).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'My bookings' })
    .click();
  await expect(page.getByText('Status: confirmed')).toBeVisible();
});
