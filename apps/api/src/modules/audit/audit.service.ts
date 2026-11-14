import type {
  AuditAction,
  AuditEntry,
  AuditLogPage,
  AuditLogQuery,
  AuditSubject,
} from '@app/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';

import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB, type Tx } from '../../infrastructure/database/database.module.js';
import { auditLog } from '../../infrastructure/database/schema.js';

export interface AuditRecord {
  actorId: string;
  action: AuditAction;
  subjectType: AuditSubject;
  subjectId: string;
  requestId: string;
}

export function toAuditEntry(row: typeof auditLog.$inferSelect): AuditEntry {
  return {
    id: String(row.id),
    at: row.at.toISOString(),
    actorId: row.actorId,
    action: row.action,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    requestId: row.requestId,
  };
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * Stores one audit row in the transaction of the change it describes: the row exists if and only
   * if that change committed. The table is append-only; this is the only writer.
   */
  async record(tx: Tx, entry: AuditRecord): Promise<void> {
    await tx.insert(auditLog).values({ ...entry, at: this.clock.now() });
  }

  /**
   * One page, newest first. `cursor` is the `id` of the last row of the previous page, so a page
   * never shifts when newer rows arrive. Reads one row more than `limit` to know whether another
   * page follows.
   */
  async list(query: AuditLogQuery): Promise<AuditLogPage> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(
        and(
          query.action === undefined ? undefined : eq(auditLog.action, query.action),
          query.actorId === undefined ? undefined : eq(auditLog.actorId, query.actorId),
          query.cursor === undefined ? undefined : lt(auditLog.id, Number(query.cursor))
        )
      )
      .orderBy(desc(auditLog.id))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit).map(toAuditEntry);
    return { items, nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null };
  }
}
