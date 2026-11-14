import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../../config/config.module.js';
import { createS3Client, S3TicketStore } from './s3-ticket-store.js';

const BUCKET = 'tickets';
const PDF = Buffer.from('%PDF-1.3 stored bytes \u0000ÿ', 'latin1');

describe('S3TicketStore against the local emulator', () => {
  const client = createS3Client(loadEnv());
  const store = new S3TicketStore(client, BUCKET);

  afterAll(() => client.destroy());

  it('returns the bytes that were stored under the booking', async () => {
    const bookingId = randomUUID();

    await store.put(bookingId, PDF);

    expect(Buffer.from((await store.get(bookingId)) ?? [])).toEqual(PDF);
  });

  it('stores a booking twice under one key: the second put replaces the first', async () => {
    const bookingId = randomUUID();

    await store.put(bookingId, Buffer.from('first'));
    await store.put(bookingId, Buffer.from('second'));

    expect(Buffer.from((await store.get(bookingId)) ?? []).toString()).toBe('second');
  });

  it('returns null for a booking without a stored ticket', async () => {
    expect(await store.get(randomUUID())).toBeNull();
  });

  it('rethrows any other failure instead of reporting an absent ticket', async () => {
    const missingBucket = new S3TicketStore(client, `missing-${randomUUID()}`);

    await expect(missingBucket.get(randomUUID())).rejects.toMatchObject({ name: 'NoSuchBucket' });
  });
});
