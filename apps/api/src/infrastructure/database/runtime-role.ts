import type { Sql } from 'postgres';

/** The login of API and worker: no superuser, not the owner, so row-level security applies to it. */
export const RUNTIME_ROLE = 'app_runtime';

/**
 * Creates the runtime role or resets its password; the caller connects as the owner. The password
 * comes from `DATABASE_URL`, so no secret lives in the repository. `create role` takes no bind
 * parameters, so the statement is built by `format` with `%I` and `%L`, which quote safely.
 */
export async function ensureRuntimeRole(owner: Sql, password: string): Promise<void> {
  const [existing] = await owner`select 1 as found from pg_roles where rolname = ${RUNTIME_ROLE}`;
  const [statement] =
    existing === undefined
      ? await owner<{ ddl: string }[]>`
          select format('create role %I login nosuperuser nobypassrls password %L',
            ${RUNTIME_ROLE}::text, ${password}::text) as ddl`
      : await owner<{ ddl: string }[]>`
          select format('alter role %I login nosuperuser nobypassrls password %L',
            ${RUNTIME_ROLE}::text, ${password}::text) as ddl`;
  if (statement === undefined) throw new Error('could not build the role statement');
  await owner.unsafe(statement.ddl);
}
