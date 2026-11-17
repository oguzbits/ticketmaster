import { expect, openEvent, test } from './fixtures';

// Uses the shared customer session: the demo login allows five per minute and address, and the
// waiting-room spec needs a second customer.
test('a customer holds multiple seats, keeps them across a reload, pays and finds the confirmed booking', async ({
  customerContext,
}) => {
  const page = await customerContext.newPage();
  await openEvent(page, 'Symphony Evening (pessimistic)');

  await page.getByLabel('Best available seats').selectOption('2');
  await page.getByRole('button', { name: 'Pick best seats' }).click();
  await page.getByRole('button', { name: 'Hold 2 seats' }).click();
  await expect(page.getByRole('heading', { name: '2 seats reserved' })).toBeVisible();
  await expect(page.getByRole('timer')).toContainText('Hold expires in');

  await page.reload();
  await expect(page.getByRole('heading', { name: '2 seats reserved' })).toBeVisible();
  await expect(page.getByRole('timer')).toContainText('Hold expires in');

  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByText('Booking confirmed.')).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'My bookings' })
    .click();
  await expect(page.getByText('Status: confirmed')).toBeVisible();
});
