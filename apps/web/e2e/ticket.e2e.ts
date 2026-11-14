import { readFile } from 'node:fs/promises';

import { BookingListResponseSchema } from '@app/shared';

import { expect, openEvent, test } from './fixtures';

const EVENT = 'Symphony Evening (pessimistic)';
/** The Mailpit REST API; `docker-compose.e2e.yml` publishes it on this port. */
const MAILPIT = 'http://127.0.0.1:18025/api/v1';
/** The worker stores the PDF and sends the mail some moments after the payment. */
const ASYNC_MS = 30_000;

/**
 * How many mails Mailpit holds with an attachment of this name. The e2e project has no JSON parser
 * of its own, so the REST answers are searched as text.
 */
async function mailsWithAttachment(fileName: string): Promise<number> {
  const list = await (await fetch(`${MAILPIT}/messages`)).text();
  const ids = [...list.matchAll(/"ID":"([^"]+)"/g)].map((match) => match[1]);
  const details = await Promise.all(
    ids.map(async (id) => (await fetch(`${MAILPIT}/message/${id}`)).text())
  );
  return details.filter((detail) => detail.includes(`"FileName":"${fileName}"`)).length;
}

test('a paid booking sends one mail with the ticket and the ticket can be downloaded', async ({
  customerContext,
}) => {
  const page = await customerContext.newPage();
  await openEvent(page, EVENT);
  await page
    .getByRole('button', { name: /, available$/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByText('Booking confirmed.')).toBeVisible();

  const listed = page.waitForResponse((response) => response.url().endsWith('/api/bookings'));
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'My bookings' })
    .click();
  const bookings = BookingListResponseSchema.parse(await (await listed).json());
  const ticketFile = `ticket-${bookings[0]?.id}.pdf`;

  // Exactly one mail carries this booking's ticket, however often the message is delivered.
  await expect.poll(() => mailsWithAttachment(ticketFile), { timeout: ASYNC_MS }).toBe(1);

  // The list was read before the worker finished, so read it again until the button shows up.
  const download = page.getByRole('button', { name: 'Download ticket' }).first();
  await expect(async () => {
    await page.reload();
    await expect(download).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: ASYNC_MS });

  const saved = page.waitForEvent('download');
  await download.click();
  const file = await saved;
  expect(file.suggestedFilename()).toBe(ticketFile);
  const content = await readFile(await file.path());
  expect(content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
});
