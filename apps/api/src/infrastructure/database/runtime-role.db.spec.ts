import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../../config/config.module.js';
import { migrationDatabaseUrl } from '../../config/env.js';
import { ensureRuntimeRole, RUNTIME_ROLE, runtimeRolePassword } from './runtime-role.js';

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
    const password = runtimeRolePassword(env.DATABASE_URL);

    await ensureRuntimeRole(owner, password);
    await ensureRuntimeRole(owner, password);

    const [role] = await owner`
      select rolsuper, rolbypassrls from pg_roles where rolname = ${RUNTIME_ROLE}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('runs for an owner that may create roles but is no superuser, also on the second run', async () => {
    const suffix = randomUUID().slice(0, 8);
    const [ownerName, roleName] = [`tm_spec_owner_${suffix}`, `tm_spec_rt_${suffix}`];
    const password = 'spec-pass';
    await owner.unsafe(`create role ${ownerName} login createrole password '${password}'`);
    const url = new URL(migrationDatabaseUrl(env));
    url.username = ownerName;
    url.password = password;
    const limited = postgres(url.toString(), { max: 1 });
    try {
      await ensureRuntimeRole(limited, password, roleName);
      await ensureRuntimeRole(limited, 'next-pass', roleName);

      const [role] = await owner`
        select rolsuper, rolbypassrls from pg_roles where rolname = ${roleName}`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally {
      await limited.end();
      await owner.unsafe(`drop role if exists ${roleName}`);
      await owner.unsafe(`drop role if exists ${ownerName}`);
    }
  });

  it('refuses an existing role that bypasses row-level security', async () => {
    const roleName = `tm_spec_rt_${randomUUID().slice(0, 8)}`;
    await owner.unsafe(`create role ${roleName} login bypassrls`);
    try {
      await expect(ensureRuntimeRole(owner, 'x', roleName)).rejects.toThrow(/bypassrls/i);
    } finally {
      await owner.unsafe(`drop role if exists ${roleName}`);
    }
  });
});
