import { expect, loginAs, openEvent, test } from './fixtures';

const EVENT = 'Waiting Room Night';
/** The worker's admission job runs every second; this is far longer than it needs. */
const ADMISSION_MS = 15_000;
const seat = (number: number) => `Section A, row 1, seat ${number}, available`;

test('a second customer waits until the first leaves', async ({
  customerContext,
  browser,
  baseURL,
}) => {
  const first = await customerContext.newPage();
  await openEvent(first, EVENT);
  const firstRoom = first.getByRole('region', { name: 'Waiting room' });
  await firstRoom.getByRole('button', { name: 'Join the waiting room' }).click();
  await expect(firstRoom.getByText(/You are admitted until/)).toBeVisible({
    timeout: ADMISSION_MS,
  });
  await first.getByRole('button', { name: seat(1), exact: true }).click();
  await expect(first.getByRole('timer').filter({ hasText: 'Hold expires in' })).toBeVisible();

  // The second customer is a different user, so a second demo login in a context of their own.
  const secondContext = await browser.newContext({ baseURL });
  try {
    const second = await secondContext.newPage();
    await loginAs(second, 'customer');
    await openEvent(second, EVENT);
    const secondRoom = second.getByRole('region', { name: 'Waiting room' });
    await secondRoom.getByRole('button', { name: 'Join the waiting room' }).click();
    await expect(secondRoom.getByRole('status').filter({ hasText: 'Position' })).toHaveText(
      'Position 1 of 1'
    );
    await expect(second.getByRole('button', { name: seat(2), exact: true })).toHaveAttribute(
      'aria-disabled',
      'true'
    );

    await firstRoom.getByRole('button', { name: 'Leave the waiting room' }).click();
    await expect(firstRoom.getByRole('button', { name: 'Join the waiting room' })).toBeVisible();

    await expect(secondRoom.getByText(/You are admitted until/)).toBeVisible({
      timeout: ADMISSION_MS,
    });
    await expect(secondRoom.getByRole('timer')).toContainText('Admission ends in');
    const wanted = second.getByRole('button', { name: seat(2), exact: true });
    await expect(wanted).not.toHaveAttribute('aria-disabled', 'true');
    await wanted.click();
    await expect(second.getByRole('timer').filter({ hasText: 'Hold expires in' })).toBeVisible();

    await second.getByRole('button', { name: 'Cancel hold' }).click();
    await first.getByRole('button', { name: 'Cancel hold' }).click();
  } finally {
    await secondContext.close();
  }
});
