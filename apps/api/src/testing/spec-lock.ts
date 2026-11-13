import { sql } from 'drizzle-orm';

import type { Database } from '../infrastructure/database/database.module.js';

/**
 * Spec files run side by side against one database. A file whose assertions depend on rows that
 * others could change (a table-wide cap, a relay that takes every unpublished row) holds a lock
 * of its own name: waits for the file that holds it, then keeps it, in a transaction that stays
 * open, until the returned function runs.
 */
export async function lockSpecs(db: Database, name: string): Promise<() => Promise<void>> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let transaction: Promise<void> = Promise.resolve();
  await new Promise<void>((acquired, failed) => {
    transaction = db
      .transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${name}))`);
        acquired();
        await held;
      })
      .catch(failed);
  });
  return async () => {
    release();
    await transaction;
  };
}
