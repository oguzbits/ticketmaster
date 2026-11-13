import type { Database } from '../../../infrastructure/database/database.module.js';
import { venues } from '../../../infrastructure/database/schema.js';

/** A fresh test database has no venue, and a simulation's sandbox event needs one. */
export async function ensureVenue(db: Database): Promise<void> {
  const [existing] = await db.select({ id: venues.id }).from(venues).limit(1);
  if (existing === undefined) await db.insert(venues).values({ name: 'test venue' });
}
