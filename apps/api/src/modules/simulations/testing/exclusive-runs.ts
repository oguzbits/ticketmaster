import { gte } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { simulationRuns } from '../../../infrastructure/database/schema.js';
import { lockSpecs } from '../../../testing/spec-lock.js';

const SPEC_LOCK_KEY = 'simulation-run-specs';

/** The start cap counts the runs of the whole table, so spec files that start or seed runs must not run side by side. */
export const lockSimulationRuns = (db: Database): Promise<() => Promise<void>> =>
  lockSpecs(db, SPEC_LOCK_KEY);

/** Deletes every run that started at `since` or later: whatever the cap of a spec at `since` sees. */
export async function clearSimulationRuns(db: Database, since: Date): Promise<void> {
  await db.delete(simulationRuns).where(gte(simulationRuns.startedAt, since));
}
