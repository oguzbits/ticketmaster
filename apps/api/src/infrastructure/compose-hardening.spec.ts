import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

const ROOT = join(import.meta.dirname, '../../../..');
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.loadtest.yml'];

const RULE = {
  DIGEST: 'digest',
  MEM_LIMIT: 'mem_limit',
  CPUS: 'cpus',
  CAP_DROP: 'cap_drop',
  NO_NEW_PRIVILEGES: 'no_new_privileges',
  READ_ONLY: 'read_only',
} as const;
type Rule = (typeof RULE)[keyof typeof RULE];

const ServiceSchema = z.object({
  image: z.string().optional(),
  build: z.unknown().optional(),
  mem_limit: z.union([z.string(), z.number()]).optional(),
  cpus: z.union([z.string(), z.number()]).optional(),
  cap_drop: z.array(z.string()).optional(),
  security_opt: z.array(z.string()).optional(),
  read_only: z.boolean().optional(),
  // A rule a service cannot meet names the rule and the reason here; an empty reason does not count.
  'x-hardening-exception': z.partialRecord(z.enum(RULE), z.string()).optional(),
});
type Service = z.infer<typeof ServiceSchema>;
const ComposeSchema = z.object({ services: z.record(z.string(), ServiceSchema) });

/** The rules a service breaks and has no written reason for. */
function violations(service: Service): Rule[] {
  const met: Record<Rule, boolean> = {
    // A service that is built here has no registry image to pin.
    [RULE.DIGEST]: service.image === undefined || /@sha256:[0-9a-f]{64}$/.test(service.image),
    [RULE.MEM_LIMIT]: service.mem_limit !== undefined,
    [RULE.CPUS]: service.cpus !== undefined,
    [RULE.CAP_DROP]: service.cap_drop?.includes('ALL') === true,
    [RULE.NO_NEW_PRIVILEGES]: service.security_opt?.includes('no-new-privileges:true') === true,
    [RULE.READ_ONLY]: service.read_only === true,
  };
  const exceptions = service['x-hardening-exception'] ?? {};
  return Object.values(RULE).filter(
    (rule) => !met[rule] && (exceptions[rule] ?? '').trim().length === 0
  );
}

const HARDENED: Service = {
  image: `postgres:18@sha256:${'a'.repeat(64)}`,
  mem_limit: '256m',
  cpus: 0.5,
  cap_drop: ['ALL'],
  security_opt: ['no-new-privileges:true'],
  read_only: true,
};

describe('compose hardening', () => {
  it.each(COMPOSE_FILES)('every service of %s meets every rule or states its reason', (file) => {
    const compose = ComposeSchema.parse(
      parse(readFileSync(join(ROOT, file), 'utf8'), { merge: true })
    );

    // A service without image and build only overrides one of docker-compose.yml.
    const broken = Object.entries(compose.services)
      .filter(([, service]) => service.image !== undefined || service.build !== undefined)
      .flatMap(([name, service]) => violations(service).map((rule) => `${name}: ${rule}`));

    expect(broken).toEqual([]);
  });

  describe('the checker', () => {
    it('accepts a hardened service', () => {
      expect(violations(HARDENED)).toEqual([]);
    });

    it.each(Object.values(RULE))('flags a service that lacks %s', (rule) => {
      const lacking: Service = { ...HARDENED };
      if (rule === RULE.DIGEST) lacking.image = 'postgres:18';
      if (rule === RULE.MEM_LIMIT) delete lacking.mem_limit;
      if (rule === RULE.CPUS) delete lacking.cpus;
      if (rule === RULE.CAP_DROP) lacking.cap_drop = ['NET_RAW'];
      if (rule === RULE.NO_NEW_PRIVILEGES) delete lacking.security_opt;
      if (rule === RULE.READ_ONLY) lacking.read_only = false;

      expect(violations(lacking)).toEqual([rule]);
    });

    it('accepts a missing rule with a reason and refuses an empty one', () => {
      const withReason: Service = {
        ...HARDENED,
        read_only: false,
        'x-hardening-exception': { [RULE.READ_ONLY]: 'writes its data directory' },
      };
      const withoutReason: Service = {
        ...withReason,
        'x-hardening-exception': { [RULE.READ_ONLY]: ' ' },
      };

      expect(violations(withReason)).toEqual([]);
      expect(violations(withoutReason)).toEqual([RULE.READ_ONLY]);
    });

    it('does not ask a built service for a digest', () => {
      const built: Service = { ...HARDENED, build: { context: '.' } };
      delete built.image;

      expect(violations(built)).toEqual([]);
    });
  });
});
