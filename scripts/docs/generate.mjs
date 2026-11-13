#!/usr/bin/env node

/**
 * Writes the generated blocks of the docs from the code (environment variables) and the OpenAPI
 * document `docs/api/openapi.json` (route table and shared schemas). `--check` writes nothing and
 * fails when a block or the document differs from the code or `.env.example` misses a variable.
 * Node runs the TypeScript config file directly (type stripping), so it must stay free of
 * relative imports and non-erasable syntax.
 */

import fs from 'node:fs';
import path from 'node:path';

import { EnvSchema } from '../../apps/api/src/config/env.ts';
import { buildOpenApi } from '../../apps/api/src/openapi/build.ts';
import { ROUTES, SCHEMAS } from '../../apps/api/src/openapi/routes.ts';
import { replaceBlocks, table } from './blocks.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TARGETS = ['CONTRIBUTING.md'];
const ENV_EXAMPLE = '.env.example';
const OPENAPI_FILE = 'docs/api/openapi.json';

function envStatus(schema) {
  if (schema.def.type === 'default') return `default \`${schema.def.defaultValue}\``;
  return schema.isOptional() ? 'optional' : 'required';
}

const BLOCKS = {
  env: () =>
    table(
      ['Variable', 'Kind'],
      Object.entries(EnvSchema.shape).map(([name, schema]) => [`\`${name}\``, envStatus(schema)])
    ),
};

const check = process.argv.includes('--check');
const problems = [];
for (const target of TARGETS) {
  const file = path.join(ROOT, target);
  const before = fs.readFileSync(file, 'utf8');
  const after = replaceBlocks(before, (name) => BLOCKS[name]?.());
  if (after === before) continue;
  if (check) problems.push(`generated block in ${target} differs from the code`);
  else fs.writeFileSync(file, after);
}

const openApiFile = path.join(ROOT, OPENAPI_FILE);
const openApi = `${JSON.stringify(buildOpenApi(ROUTES, SCHEMAS), null, 2)}\n`;
if (!fs.existsSync(openApiFile) || fs.readFileSync(openApiFile, 'utf8') !== openApi) {
  if (check) problems.push(`${OPENAPI_FILE} differs from the route table and the shared schemas`);
  else fs.writeFileSync(openApiFile, openApi);
}

const example = fs.readFileSync(path.join(ROOT, ENV_EXAMPLE), 'utf8');
for (const name of Object.keys(EnvSchema.shape)) {
  if (!new RegExp(`^#? ?${name}=`, 'm').test(example)) {
    problems.push(`${ENV_EXAMPLE} does not list ${name}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.stderr.write('Run `pnpm docs:generate`, complete the example file and commit.\n');
  process.exit(1);
}
process.stdout.write(check ? 'docs:generate ok\n' : 'docs:generate written\n');
