import type { Sql } from 'postgres';

/** The login of API and worker: no superuser, not the owner, so row-level security applies to it. */
export const RUNTIME_ROLE = 'app_runtime';

/** The password of a database URL as the client sends it: the URL form is percent-encoded. */
export function runtimeRolePassword(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).password);
}

/**
 * Creates the runtime role or resets its password; the caller connects as the owner. The password
 * comes from `DATABASE_URL`, so no secret lives in the repository. An existing role keeps its
 * attributes (changing them needs a superuser); one that bypasses row-level security is refused.
 * `create role` takes no bind parameters, so the statement is built by `format` with `%I` and
 * `%L`, which quote safely.
 */
export async function ensureRuntimeRole(
  owner: Sql,
  password: string,
  role: string = RUNTIME_ROLE
): Promise<void> {
  const [existing] = await owner<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = ${role}`;
  if (existing !== undefined && (existing.rolsuper || existing.rolbypassrls)) {
    throw new Error(
      `role ${role} is a superuser or has bypassrls: row-level security would not apply`
    );
  }
  const [statement] =
    existing === undefined
      ? await owner<{ ddl: string }[]>`
          select format('create role %I login nosuperuser nobypassrls password %L',
            ${role}::text, ${password}::text) as ddl`
      : await owner<{ ddl: string }[]>`
          select format('alter role %I password %L', ${role}::text, ${password}::text) as ddl`;
  if (statement === undefined) throw new Error('could not build the role statement');
  await owner.unsafe(statement.ddl);
}
