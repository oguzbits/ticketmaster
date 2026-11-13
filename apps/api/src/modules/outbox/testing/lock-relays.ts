import type { Database } from '../../../infrastructure/database/database.module.js';
import { lockSpecs } from '../../../testing/spec-lock.js';

const SPEC_LOCK_KEY = 'outbox-relay-specs';

/**
 * A relay takes every unpublished row of the table, also those another spec file has just written
 * and still expects to find unpublished. Specs that run a relay hold this lock meanwhile.
 */
export const lockOutboxRelays = (db: Database): Promise<() => Promise<void>> =>
  lockSpecs(db, SPEC_LOCK_KEY);
