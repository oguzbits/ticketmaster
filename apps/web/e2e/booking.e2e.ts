import { expect, openEvent, test } from './fixtures';

// Uses the shared customer session: the demo login allows five per minute and address, and the
// waiting-room spec needs a second customer.
test('a customer holds a seat, pays and finds the confirmed booking', async ({
  customerContext,
}) => {
  const page = await customerContext.newPage();
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
