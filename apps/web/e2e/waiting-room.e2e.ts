import { expect, loginAs, openEvent, SESSION_KEY, test } from './fixtures';

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

    // An admitted customer has no button to give the admission back, so the first customer leaves
    // through the API with their own token.
    const session = await first.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY);
    const token = /"accessToken":"([^"]+)"/.exec(session ?? '')?.[1];
    const eventId = new URL(first.url()).pathname.split('/').pop();
    if (token === undefined || eventId === undefined) throw new Error('No session or event ID');
    const left = await first.request.delete(`/api/events/${eventId}/waiting-room`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(left.ok()).toBe(true);

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
