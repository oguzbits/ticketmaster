import type { AuditAction, AuditEntry, AuditSubject } from '@app/shared';
import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../core/clock.js';
import type { Tx } from '../../infrastructure/database/database.module.js';
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
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /**
   * Stores one audit row in the transaction of the change it describes: the row exists if and only
   * if that change committed. The table is append-only; this is the only writer.
   */
  async record(tx: Tx, entry: AuditRecord): Promise<void> {
    await tx.insert(auditLog).values({ ...entry, at: this.clock.now() });
  }
}
