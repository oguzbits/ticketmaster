#!/usr/bin/env node
import os from 'node:os';

import { checkBashCommand } from './bash-rules.mjs';

/**
 * PreToolUse hook for Bash. Blocks force pushes and `--no-verify` (commits and pushes themselves are
 * allowed, the Husky hooks are the gate), recursive rm outside the project's subfolders and any
 * reference to secret files. A heredoc body is read like any other text, so a comment that names a
 * secrets file trips it: write files with the Write tool instead. Fails closed: if this hook itself breaks, the
 * command is blocked (exit 2) instead of silently allowed.
 */

const TMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir()];

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
  const payload = JSON.parse(await readStdin());
  const command = payload?.tool_input?.command;
  if (payload?.tool_name !== 'Bash' || typeof command !== 'string') {
    process.exit(0);
  }

  const cwd = payload.cwd ?? process.cwd();
  const reason = checkBashCommand(command, {
    projectDir: process.env.CLAUDE_PROJECT_DIR ?? cwd,
    cwd,
    homeDir: os.homedir(),
    tmpRoots: TMP_ROOTS,
  });

  if (reason) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Guard: ${reason}`,
        },
      })}\n`
    );
  }
} catch (error) {
  process.stderr.write(`guard-bash failed, blocking the command: ${error.message}\n`);
  process.exit(2);
}
