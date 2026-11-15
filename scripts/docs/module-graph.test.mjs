import { describe, expect, it } from 'vitest';

import { apiSourceOf, moduleGraph, nodeOf } from './module-graph.mjs';

const file = (source, ...resolved) => ({
  source,
  dependencies: resolved.map((r) => ({ resolved: r })),
});
const BOOKINGS = 'apps/api/src/modules/bookings/bookings.service.ts';
const WAITING = 'apps/api/src/modules/waiting-room/index.ts';
const DATABASE = 'apps/api/src/infrastructure/database/db.ts';
const WORKER_JOB = 'apps/worker/src/hold-expiry.job.ts';

describe('nodeOf', () => {
  it('names a module, a layer and the worker, and nothing else', () => {
    expect(nodeOf(BOOKINGS)).toEqual({ kind: 'module', name: 'bookings' });
    expect(nodeOf(DATABASE)).toEqual({ kind: 'layer', name: 'infrastructure' });
    expect(nodeOf(WORKER_JOB)).toEqual({ kind: 'worker', name: 'worker' });
    expect(nodeOf('packages/shared/src/index.ts')).toBeNull();
    expect(nodeOf('apps/api/src/config/env.ts')).toBeNull();
  });

  it('leaves out specs and test support', () => {
    expect(nodeOf('apps/api/src/modules/bookings/bookings.service.spec.ts')).toBeNull();
    expect(nodeOf('apps/api/src/modules/bookings/testing/fakes.ts')).toBeNull();
  });
});

describe('moduleGraph', () => {
  const graph = moduleGraph({
    modules: [
      file(
        BOOKINGS,
        WAITING,
        DATABASE,
        'apps/api/src/modules/bookings/other.ts',
        'packages/shared/src/index.ts'
      ),
      file(WORKER_JOB, BOOKINGS),
      file('apps/api/src/modules/bookings/x.spec.ts', 'apps/api/src/modules/audit/index.ts'),
    ],
  });

  it('draws one edge per dependency between two nodes', () => {
    expect(graph).toContain('bookings --> waiting_room');
    expect(graph).toContain('bookings --> infrastructure');
    expect(graph).toContain('worker --> bookings');
  });

  it('draws no edge inside a node, to a file outside the graph or from a spec', () => {
    expect(graph.match(/-->/g)).toHaveLength(3);
    expect(graph).not.toContain('audit');
  });

  it('is stable whatever order the files come in', () => {
    const reversed = moduleGraph({
      modules: [file(WORKER_JOB, BOOKINGS), file(BOOKINGS, DATABASE, WAITING)],
    });
    expect(reversed).toBe(
      moduleGraph({ modules: [file(BOOKINGS, WAITING, DATABASE), file(WORKER_JOB, BOOKINGS)] })
    );
  });
});

describe('apiSourceOf', () => {
  const exportsMap = {
    './bookings': { default: './dist/modules/bookings/index.js' },
    './database': { default: './dist/infrastructure/database/database.module.js' },
  };

  it('maps an export of the API package to its source file', () => {
    expect(apiSourceOf('@app/api/bookings', exportsMap)).toBe(
      'apps/api/src/modules/bookings/index.ts'
    );
    expect(nodeOf(apiSourceOf('@app/api/database', exportsMap) ?? '')?.name).toBe('infrastructure');
  });

  it('answers null for a specifier the package does not export', () => {
    expect(apiSourceOf('@app/api/unknown', exportsMap)).toBeNull();
  });
});
