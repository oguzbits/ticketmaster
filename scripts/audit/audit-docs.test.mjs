import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { auditDocs } from './audit-docs.mjs';

const dirs = [];

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-docs-'));
  dirs.push(dir);
  const all = {
    'package.json': JSON.stringify({ scripts: { check: 'x', 'db:up': 'y' } }),
    'apps/api/src/index.ts': '',
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function audit(doc, extra = {}) {
  return auditDocs(makeRepo({ 'README.md': doc, ...extra })).map((v) => v.message);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('auditDocs', () => {
  it('accepts a document whose links, commands and paths exist', () => {
    const doc =
      '# Titel\n\nSiehe [Plan](docs/PLAN.md#ziel), `pnpm check`, `apps/api/src/index.ts`.\n';
    expect(audit(doc, { 'docs/PLAN.md': '# Plan\n\n## Ziel\n' })).toEqual([]);
  });

  it('reports a link to a missing file', () => {
    expect(audit('[x](docs/fehlt.md)\n')).toEqual([expect.stringContaining('docs/fehlt.md')]);
  });

  it('reports a link to a missing anchor and resolves links relative to the file', () => {
    const files = { 'docs/a.md': '[b](b.md#weg) [ok](b.md#da)\n', 'docs/b.md': '## Da\n' };
    const found = auditDocs(makeRepo(files)).map((v) => v.message);
    expect(found).toEqual([expect.stringContaining('#weg')]);
  });

  it('ignores external links and line anchors on code files', () => {
    const doc = '[a](https://example.com) [b](mailto:a@b.de) [c](apps/api/src/index.ts#L3)\n';
    expect(audit(doc)).toEqual([]);
  });

  it('lets specs and plans name future paths and scripts, but still checks their links', () => {
    const plan = 'Create `apps/api/src/neu.ts`, run `pnpm neu`, see [x](fehlt.md).\n';
    const found = auditDocs(makeRepo({ 'docs/superpowers/plans/p.md': plan })).map(
      (v) => v.message
    );
    expect(found).toEqual([expect.stringContaining('fehlt.md')]);
  });

  it('reports a pnpm command that no package.json defines', () => {
    expect(audit('Run `pnpm does-not-exist`.\n')).toEqual([
      expect.stringContaining('does-not-exist'),
    ]);
  });

  it('reads the script name after pnpm flags and accepts built-in commands', () => {
    const doc = '`pnpm --filter @nlm/api db:up` and `pnpm install`\n';
    expect(audit(doc)).toEqual([]);
  });

  it('reports a path under apps, packages or deploy that does not exist', () => {
    const doc = '`apps/api/src/gone.ts` and `apps/api/src/index.ts:12`\n';
    expect(audit(doc)).toEqual([expect.stringContaining('apps/api/src/gone.ts')]);
  });

  it('reports an absolute machine path', () => {
    expect(audit('Lives in /Users/someone/Dev/x.\n')).toEqual([expect.stringContaining('/Users/')]);
  });

  it('reports a test count but not the word tests alone', () => {
    expect(audit('All 1179 tests pass.\n')).toEqual([expect.stringContaining('1179 tests')]);
    expect(audit('Tests run offline.\n')).toEqual([]);
  });

  it('skips fenced code blocks for commands and counts but not for absolute paths', () => {
    const doc = '```\npnpm does-not-exist\n12 tests\n/Users/someone/x\n```\n';
    expect(audit(doc)).toEqual([expect.stringContaining('/Users/')]);
  });

  it('reports a date or a status word in the stable context document, and only there', () => {
    const doc = 'The limit has been built since 2026-10-03.\n';
    expect(audit(doc)).toEqual([]);
    expect(auditDocs(makeRepo({ 'docs/PLAN.md': doc })).map((v) => v.message)).toEqual([
      expect.stringContaining('state in a stable document'),
    ]);
  });

  it('reports "done" as a status word but accepts the term Definition of Done', () => {
    const plan = (doc) => auditDocs(makeRepo({ 'docs/PLAN.md': doc })).map((v) => v.message);
    expect(plan('The waiting room is done.\n')).toEqual([expect.stringContaining('done')]);
    expect(plan('## Definition of Done\n')).toEqual([]);
  });

  it('reports the line of the finding', () => {
    const [violation] = auditDocs(makeRepo({ 'README.md': 'ok\n\n[x](weg.md)\n' }));
    expect(violation).toMatchObject({ file: 'README.md', line: 3 });
  });
});
