import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';
import { migrationDatabaseUrl } from '../../config/env.js';
import { ensureRuntimeRole, RUNTIME_ROLE } from './runtime-role.js';

const env = loadEnv();
const runtime = postgres(env.DATABASE_URL, { max: 1 });
const owner = postgres(migrationDatabaseUrl(env), { max: 1 });

describe('runtime role', () => {
  afterAll(async () => {
    await runtime.end();
    await owner.end();
  });

  it('is what the app connects as, without superuser, row-security bypass or table ownership', async () => {
    const [role] = await runtime`
      select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    const owned = await runtime`select tablename from pg_tables where tableowner = current_user`;

    expect(role).toEqual({ name: RUNTIME_ROLE, rolsuper: false, rolbypassrls: false });
    expect(owned).toEqual([]);
  });

  it('can be ensured again and takes the password of the URL', async () => {
    const password = new URL(env.DATABASE_URL).password;

    await ensureRuntimeRole(owner, password);
    await ensureRuntimeRole(owner, password);

    const [role] = await owner`
      select rolsuper, rolbypassrls from pg_roles where rolname = ${RUNTIME_ROLE}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
