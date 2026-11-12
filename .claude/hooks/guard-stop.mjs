#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Stop hook: when code files changed, `pnpm check` must pass before the agent may finish.
 * A failure blocks the stop once and hands the output back. If the hook is already active
 * (`stop_hook_active`) it lets the agent stop, so a check that cannot be fixed never loops forever.
 * A pass is remembered by a hash of the changed code files, so a turn that changed nothing since
 * does not pay for the check again. A failure is never remembered. A check that runs out of time
 * says nothing about the code, so it does not block.
 */

/** A hash of the content of the changed code files, to tell "same code as the last pass". */
function fingerprint(cwd, status) {
  const hash = crypto.createHash('sha1');
  for (const line of status.split('\n')) {
    const file = line.slice(3).trim().split(' -> ').pop();
    if (!file || !CODE_FILE.test(file)) continue;
    hash.update(file);
    try {
      hash.update(fs.readFileSync(path.join(cwd, file)));
    } catch (error) {
      if (error.code !== ERROR_CODE.NOT_FOUND) throw error;
      hash.update('deleted');
    }
  }
  return hash.digest('hex');
}

const CODE_FILE = /\.(ts|tsx|mjs|cjs|js)$/;
const MAX_REASON_CHARS = 3000;
const CHECK_TIMEOUT_MS = Number(process.env.GUARD_STOP_TIMEOUT_MS) || 100_000;
const PASSED_MARK = 'guard-stop-last-pass';
const ERROR_CODE = { NOT_FOUND: 'ENOENT', TIMED_OUT: 'ETIMEDOUT' };
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

try {
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  if (payload.stop_hook_active) process.exit(0);

  const cwd = process.env.CLAUDE_PROJECT_DIR ?? payload.cwd ?? process.cwd();

  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  } catch (error) {
    process.stderr.write(`guard-stop: git status failed, not gating (${error.message})\n`);
    process.exit(0);
  }

  const hasCodeChanges = status.split('\n').some((line) => CODE_FILE.test(line.trim()));
  if (!hasCodeChanges) process.exit(0);

  const markFile = execFileSync('git', ['rev-parse', '--git-path', PASSED_MARK], {
    cwd,
    encoding: 'utf8',
  }).trim();
  const markPath = path.resolve(cwd, markFile);
  const current = fingerprint(cwd, status);
  if (fs.existsSync(markPath) && fs.readFileSync(markPath, 'utf8') === current) process.exit(0);

  const result = spawnSync('pnpm', ['check'], {
    cwd,
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
  });
  if (result.error?.code === ERROR_CODE.TIMED_OUT) {
    process.stderr.write(
      `guard-stop: pnpm check timed out after ${CHECK_TIMEOUT_MS} ms, not gating\n`
    );
    process.exit(0);
  }
  if (result.status === 0) {
    fs.writeFileSync(markPath, current);
    process.exit(0);
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(ANSI, '');
  process.stdout.write(
    `${JSON.stringify({
      decision: 'block',
      reason: `pnpm check failed. Fix these errors before finishing:\n\n${output.slice(-MAX_REASON_CHARS)}`,
    })}\n`
  );
} catch (error) {
  process.stderr.write(`guard-stop failed, not gating: ${error.message}\n`);
  process.exit(0);
}
