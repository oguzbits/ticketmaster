import { sql } from 'drizzle-orm';

import type { Tx } from './database.module.js';

/** `USER` restricts the booking tables to the rows of `app.user_id`; any other value restricts nothing. */
export const RLS_SCOPE = { USER: 'user', SYSTEM: 'system' } as const;
export const RLS_SETTING = { SCOPE: 'app.scope', USER_ID: 'app.user_id' } as const;

/**
 * Runs `run` with the booking policies restricted to `userId`, a second layer behind the ownership
 * filters of the queries. Transaction-local (`set_config(..., true)`), so a pooled connection in
 * transaction mode carries nothing over. If `run` throws, the caller's transaction rolls back and
 * takes the setting with it; the scope is not reset on that path.
 */
export async function withOwner<T>(tx: Tx, userId: string, run: () => Promise<T>): Promise<T> {
  await tx.execute(
    sql`select set_config(${RLS_SETTING.SCOPE}, ${RLS_SCOPE.USER}, true), set_config(${RLS_SETTING.USER_ID}, ${userId}, true)`
  );
  const result = await run();
  await tx.execute(sql`select set_config(${RLS_SETTING.SCOPE}, ${RLS_SCOPE.SYSTEM}, true)`);
  return result;
}
