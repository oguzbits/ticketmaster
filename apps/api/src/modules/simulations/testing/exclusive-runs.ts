import { gte, sql } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { simulationRuns } from '../../../infrastructure/database/schema.js';

const SPEC_LOCK_KEY = 'simulation-run-specs';

/**
 * The start cap counts the runs of the whole table, so spec files that start or seed runs must not
 * run side by side. Waits for the file that holds the lock and keeps it, in a transaction that
 * stays open, until the returned function runs.
 */
export async function lockSimulationRuns(db: Database): Promise<() => Promise<void>> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let transaction: Promise<void> = Promise.resolve();
  await new Promise<void>((acquired, failed) => {
    transaction = db
      .transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SPEC_LOCK_KEY}))`);
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

/** Deletes every run that started at `since` or later: whatever the cap of a spec at `since` sees. */
export async function clearSimulationRuns(db: Database, since: Date): Promise<void> {
  await db.delete(simulationRuns).where(gte(simulationRuns.startedAt, since));
}
