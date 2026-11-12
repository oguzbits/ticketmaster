import { describe, expect, it } from 'vitest';

import { missingDocs } from './audit-docs-map.mjs';

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
