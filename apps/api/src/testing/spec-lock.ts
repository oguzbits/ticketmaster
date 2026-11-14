import { type SQL, sql } from 'drizzle-orm';

/** What the lock needs of the database: a transaction that runs one statement. */
interface LockDatabase {
  transaction(
    run: (tx: { execute(query: SQL): PromiseLike<object> }) => Promise<void>
  ): Promise<void>;
}

/**
 * Spec files run side by side against one database. A file whose assertions depend on rows that
 * others could change (a table-wide cap, a relay that takes every unpublished row) holds a lock
 * of its own name: waits for the file that holds it, then keeps it, in a transaction that stays
 * open, until the returned function runs. A lock transaction that fails makes that function throw:
 * the lock was lost and the file may have run unprotected.
 */
export async function lockSpecs(db: LockDatabase, name: string): Promise<() => Promise<void>> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let transaction: Promise<void> = Promise.resolve();
  await new Promise<void>((acquired, failed) => {
    transaction = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${name}))`);
      acquired();
      await held;
    });
    // Before the lock is taken the failure rejects the call; after it, the release function throws.
    transaction.catch(failed);
  });
  return async () => {
    release();
    await transaction;
  };
}
