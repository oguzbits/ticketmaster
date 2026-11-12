import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guard-bash.mjs');
const projectDir = path.resolve(path.dirname(script), '../..');

function runHook(input) {
  return spawnSync('node', [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

const bash = (command) => ({ tool_name: 'Bash', cwd: projectDir, tool_input: { command } });

describe('guard-bash process', () => {
  it('denies with the documented JSON shape', () => {
    const result = runHook(bash('git push --force origin main'));
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/git push/);
  });

  it('stays silent for a harmless command', () => {
    const result = runHook(bash('pnpm check'));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('ignores other tools', () => {
    const result = runHook({ tool_name: 'Read', tool_input: { file_path: 'a.ts' } });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('fails closed on unparseable input', () => {
    const result = runHook('not json');

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/blocking the command/);
  });
});
