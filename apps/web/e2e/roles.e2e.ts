import { expect, loginAs, test } from './fixtures';

test('an organizer reaches the organizer screen with the events they own', async ({ page }) => {
  await loginAs(page, 'organizer');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Organizer' })
    .click();

  await expect(page.getByRole('heading', { level: 1, name: 'Your events' })).toBeVisible();
  await expect(page.getByText(/seats sold/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create an event' })).toBeVisible();
});

test('an admin switches the booking strategy of an event', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.getByRole('main').getByRole('link').first().click();

  await expect(page.getByRole('heading', { name: 'Booking strategy' })).toBeVisible();
  const current = (await page.getByText(/^Current strategy: /).textContent())?.split(': ')[1];
  const options = await page.getByLabel('New strategy').locator('option').allTextContents();
  const next = options.find((option) => option !== current);
  if (next === undefined) throw new Error('The strategy list has no other entry');

  await page.getByLabel('New strategy').selectOption(next);
  await page.getByRole('button', { name: 'Switch strategy' }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(`The strategy is now ${next}.`)).toBeVisible();
});

test('a customer is sent away from the organizer screen', async ({ customerContext }) => {
  const page = await customerContext.newPage();
  await page.goto('/organizer');

  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByRole('heading', { name: 'Your events' })).toHaveCount(0);
});
