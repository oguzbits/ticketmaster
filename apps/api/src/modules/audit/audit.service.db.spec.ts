import { randomUUID } from 'node:crypto';

import { AUDIT_ACTION, AUDIT_SUBJECT } from '@app/shared';
import { afterAll, describe, expect, it } from 'vitest';

import type { Clock } from '../../core/clock.js';
import { openTestDatabase } from '../../testing/database.js';
import { AuditService } from './audit.service.js';
import { auditRows } from './testing/index.js';

const NOW = new Date('2001-02-03T04:05:06.000Z');

class Rollback extends Error {}

describe('AuditService.record', () => {
  const database = openTestDatabase();
  const { db } = database;
  const clock: Clock = { now: () => NOW };
  const audit = new AuditService(db, clock);
  const rowsOf = async (actorId: string) =>
    (await auditRows(db)).filter((row) => row.actorId === actorId);

  afterAll(() => database.close());

  const entry = () => ({
    actorId: randomUUID(),
    action: AUDIT_ACTION.EVENT_CREATED,
    subjectType: AUDIT_SUBJECT.EVENT,
    subjectId: randomUUID(),
    requestId: 'req-1',
  });

  it('stores one row with the given fields and the time of the clock when the transaction commits', async () => {
    const input = entry();

    await db.transaction((tx) => audit.record(tx, input));

    expect(await rowsOf(input.actorId)).toEqual([
      { ...input, id: expect.stringMatching(/^\d+$/), at: NOW.toISOString() },
    ]);
  });

  it('leaves no row when the transaction rolls back', async () => {
    const input = entry();

    await expect(
      db.transaction(async (tx) => {
        await audit.record(tx, input);
        throw new Rollback();
      })
    ).rejects.toThrow(Rollback);

    expect(await rowsOf(input.actorId)).toEqual([]);
  });
});
