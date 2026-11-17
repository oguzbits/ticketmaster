import { expect, openEvent, test } from './fixtures';

const EVENT = 'Jazz Gala (optimistic)';
/** The seat map in the other tab has this long, once the hold or release is stored, to show the change. */
const LIVE_MS = 1000;

test('a hold in one tab shows in another tab within a second, and so does its release', async ({
  page: viewer,
  customerContext,
}) => {
  // The viewer is not signed in: the seat map and its stream are public.
  const streamOpened = viewer.waitForResponse((response) =>
    response.url().includes('/seats/stream')
  );
  await openEvent(viewer, EVENT);
  await streamOpened;

  const buyer = await customerContext.newPage();
  await openEvent(buyer, EVENT);
  const seat = buyer.getByRole('button', { name: /, available$/ }).first();
  const label = (await seat.getAttribute('aria-label'))?.replace(/available$/, '');
  if (label === undefined) throw new Error('The seat has no label');
  const seatInViewer = (status: string) =>
    viewer.getByRole('button', { name: `${label}${status}`, exact: true });

  await seat.click();
  await buyer.getByRole('button', { name: 'Hold 1 seat' }).click();
  await expect(buyer.getByRole('timer').filter({ hasText: 'Hold expires in' })).toBeVisible();
  await expect(seatInViewer('held')).toBeVisible({ timeout: LIVE_MS });

  // Only a change event can carry this one: the viewer's snapshot is older than the hold.
  await buyer.getByRole('button', { name: 'Cancel hold' }).click();
  await expect(buyer.getByRole('button', { name: 'Cancel hold' })).toHaveCount(0);
  await expect(seatInViewer('available')).toBeVisible({ timeout: LIVE_MS });
});
