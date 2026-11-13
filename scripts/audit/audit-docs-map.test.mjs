import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { auditRange, missingDocs } from './audit-docs-map.mjs';

const MAP = { 'a/limits.ts': 'docs/PLAN.md', 'deploy/': 'docs/DEPLOYMENT.md' };

describe('missingDocs', () => {
  it('reports a mapped file changed without its document', () => {
    expect(missingDocs(MAP, ['a/limits.ts'], 'feat: x')).toEqual([
      { path: 'a/limits.ts', doc: 'docs/PLAN.md' },
    ]);
  });

  it('accepts the change when the document changes too', () => {
    expect(missingDocs(MAP, ['a/limits.ts', 'docs/PLAN.md'], 'feat: x')).toEqual([]);
  });

  it('matches a folder entry by prefix', () => {
    expect(missingDocs(MAP, ['deploy/Caddyfile'], 'x')).toEqual([
      { path: 'deploy/Caddyfile', doc: 'docs/DEPLOYMENT.md' },
    ]);
  });

  it('accepts any document inside a mapped document folder', () => {
    const map = { 'deploy/': 'docs/runbooks/' };
    expect(missingDocs(map, ['deploy/Caddyfile', 'docs/runbooks/deploy.md'], 'x')).toEqual([]);
    expect(missingDocs(map, ['deploy/Caddyfile', 'docs/PLAN.md'], 'x')).toHaveLength(1);
  });

  it('accepts a waiver with a reason and rejects one without', () => {
    expect(missingDocs(MAP, ['a/limits.ts'], 'feat: x\n\nDocs: n/a, only a comment')).toEqual([]);
    expect(missingDocs(MAP, ['a/limits.ts'], 'feat: x\n\nDocs: n/a,')).toHaveLength(1);
  });

  it('ignores paths outside the map and does not match a file by prefix', () => {
    expect(missingDocs(MAP, ['a/other.ts', 'a/limits.ts.bak'], 'x')).toEqual([]);
  });
});

describe('auditRange', () => {
  it('checks each commit against the map as it was in that commit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-docs-map-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    const commit = (files, message) => {
      for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), content);
      }
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    try {
      git('init', '-q');
      const base = commit({ 'docs/docs-map.json': '{}' }, 'chore: base');
      commit({ 'src/db.ts': '1' }, 'feat: db before its mapping');
      commit({ 'docs/docs-map.json': '{"src/db.ts": "docs/db.md"}' }, 'chore: map db');
      commit({ 'src/db.ts': '2' }, 'feat: db after its mapping');

      expect(auditRange(dir, `${base}..HEAD`)).toEqual([
        { label: expect.any(String), path: 'src/db.ts', doc: 'docs/db.md' },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
