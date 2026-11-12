import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guard-stop.mjs');
const dirs = [];

function makeRepo({ checkScript, codeFile }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-stop-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'probe', scripts: { check: checkScript } })
  );
  spawnSync('git', ['init', '-q'], { cwd: dir });
  if (codeFile) fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  return dir;
}

function runHook(dir, payload = {}, env = {}) {
  return spawnSync('node', [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('guard-stop process', () => {
  it('blocks the stop when code changed and the check fails', () => {
    const dir = makeRepo({ checkScript: 'echo BROKEN_TYPES && exit 1', codeFile: true });
    const result = runHook(dir);
    const output = JSON.parse(result.stdout);

    expect(output.decision).toBe('block');
    expect(output.reason).toContain('BROKEN_TYPES');
  });

  it('allows the stop when the check passes', () => {
    const dir = makeRepo({ checkScript: 'exit 0', codeFile: true });

    expect(runHook(dir).stdout).toBe('');
  });

  it('does not run the check when no code file changed', () => {
    const dir = makeRepo({ checkScript: 'exit 1', codeFile: false });

    expect(runHook(dir).stdout).toBe('');
  });

  it('lets the agent stop when stop_hook_active is set, so it cannot loop', () => {
    const dir = makeRepo({ checkScript: 'exit 1', codeFile: true });

    expect(runHook(dir, { stop_hook_active: true }).stdout).toBe('');
  });

  it('does not run the check again for code it has already passed', () => {
    const dir = makeRepo({ checkScript: 'echo run >> runs.txt', codeFile: true });

    runHook(dir);
    runHook(dir);
    expect(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(1);

    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
    runHook(dir);
    expect(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('checks again after a failure, because a failure is never remembered', () => {
    const dir = makeRepo({ checkScript: 'echo run >> runs.txt; exit 1', codeFile: true });

    runHook(dir);
    runHook(dir);

    expect(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('does not block when the check runs out of time: that is no failure of the code', () => {
    const dir = makeRepo({ checkScript: 'sleep 5', codeFile: true });
    const result = runHook(dir, {}, { GUARD_STOP_TIMEOUT_MS: '300' });

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('timed out');
  });
});
