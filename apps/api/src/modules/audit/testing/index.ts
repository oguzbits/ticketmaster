import type { AuditEntry } from '@app/shared';
import { asc } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { auditLog } from '../../../infrastructure/database/schema.js';
import { toAuditEntry } from '../audit.service.js';

/** Every audit row, oldest first. The table is shared by the db specs: filter by your own IDs. */
export async function auditRows(db: Database): Promise<AuditEntry[]> {
  return (await db.select().from(auditLog).orderBy(asc(auditLog.id))).map(toAuditEntry);
}
