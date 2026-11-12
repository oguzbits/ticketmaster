import path from 'node:path';

/**
 * Deterministic guard rules for Bash commands. Pure: no I/O, all context is passed in.
 * Returns a reason string when the command must be blocked, otherwise null.
 *
 * Best effort, not a security boundary: the command text is analysed statically, so a script that
 * builds a command at runtime is out of reach. The permission rules in settings.json and the
 * user's own review remain the other layers.
 */

const MAX_DEPTH = 3;
const SEGMENT_SEPARATOR = /&&|\|\||[;|&\n]/;
const TOKEN = /(?:[^\s"']|"[^"]*"|'[^']*')+/g;
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec', 'xargs']);
const SHELLS = new Set(['sh', 'bash', 'zsh']);
// Committing and pushing are allowed: the Husky hooks (`pnpm check`, `pnpm test`) are the gate.
// Blocked are the ways around it and the ways to destroy remote history.
const FORCE_PUSH_FLAG =
  /^(--force(-with-lease|-if-includes)?(=.*)?|--delete|--mirror|-[a-zA-Z]*[fd][a-zA-Z]*)$/;
const NO_VERIFY_FLAG = /^(--no-verify|-[a-zA-Z]*n[a-zA-Z]*)$/;
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const GLOB_CHARS = /[*?[{]/;
const DYNAMIC_PATH = /[`$]/;
const SECRET_FILE = /(^|[/=])(\.env(\.[^/]*)?|id_rsa[^/]*|[^/]+\.pem)$/;
const SECRET_EXAMPLE = /\.env\.example$/;
// The one allowed use of a secrets file: Node loads it itself for a reviewed spike script, so the
// agent never reads or prints it. Exactly `node --env-file=.env.local spikes/<name>.mjs ...`.
const SPIKE_ENV_FLAG = '--env-file=.env.local';
const SPIKE_SCRIPT = /^spikes\/[\w-]+\.mjs$/;

function tokenize(segment) {
  return (segment.match(TOKEN) ?? []).map((token) => token.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'));
}

function stripWrappers(tokens) {
  const rest = [...tokens];
  let viaXargs = false;
  while (rest.length > 0) {
    const head = rest[0];
    const name = path.basename(head);
    if (WRAPPERS.has(name)) {
      viaXargs ||= name === 'xargs';
      rest.shift();
    } else if (/^[A-Za-z_]\w*=/.test(head)) {
      rest.shift();
    } else {
      break;
    }
  }
  return { rest, viaXargs };
}

function gitSubcommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (GIT_OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
    } else if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return null;
}

function isRecursiveRm(flags) {
  return flags.some((flag) => flag === '--recursive' || (/^-[^-]/.test(flag) && /[rR]/.test(flag)));
}

function isInside(root, target) {
  return target.startsWith(root + path.sep);
}

function checkRmTarget(rawTarget, ctx) {
  if (DYNAMIC_PATH.test(rawTarget)) {
    return `target "${rawTarget}" contains a variable or substitution that cannot be verified`;
  }

  let target = rawTarget;
  if (target === '~' || target.startsWith('~/')) {
    target = path.join(ctx.homeDir, target.slice(1));
  } else if (target.startsWith('~')) {
    return `target "${rawTarget}" refers to another user's home`;
  }

  const segments = target.split('/');
  const globIndex = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  if (globIndex >= 0) {
    target = segments.slice(0, globIndex).join('/') || (target.startsWith('/') ? '/' : '.');
  }

  const resolved = path.resolve(ctx.cwd, target);
  const gitDir = path.join(ctx.projectDir, '.git');
  const insideProject =
    isInside(ctx.projectDir, resolved) && resolved !== gitDir && !isInside(gitDir, resolved);
  const insideTmp = ctx.tmpRoots.some((root) => isInside(root, resolved));

  return insideProject || insideTmp
    ? null
    : `"${rawTarget}" resolves to ${resolved}, outside the project subfolders (project root and .git are protected)`;
}

function checkSegment(segment, ctx, depth) {
  const { rest, viaXargs } = stripWrappers(tokenize(segment));
  if (rest.length === 0) return null;

  const command = path.basename(rest[0]);
  const args = rest.slice(1);

  if (command === 'git') {
    const sub = gitSubcommand(args);
    const flags = sub ? args.slice(args.indexOf(sub) + 1) : [];
    if (sub === 'push' && flags.some((f) => FORCE_PUSH_FLAG.test(f) || f.startsWith('+'))) {
      return 'git push is blocked when it forces, deletes or mirrors: never rewrite remote history.';
    }
    if (sub === 'commit' && flags.some((f) => NO_VERIFY_FLAG.test(f))) {
      return 'git commit is blocked with --no-verify or -n: the hooks are the quality gate.';
    }
  }

  if (command === 'rm') {
    const flags = args.filter((arg) => arg.startsWith('-'));
    const targets = args.filter((arg) => !arg.startsWith('-'));
    if (isRecursiveRm(flags)) {
      if (viaXargs) return 'recursive rm via xargs cannot be verified.';
      for (const target of targets) {
        const problem = checkRmTarget(target, ctx);
        if (problem) return `Recursive rm blocked: ${problem}.`;
      }
    }
  }

  if (depth < MAX_DEPTH) {
    const cIndex = args.indexOf('-c');
    if (SHELLS.has(command) && cIndex >= 0 && args[cIndex + 1]) {
      const nested = checkBashCommand(args[cIndex + 1], ctx, depth + 1);
      if (nested) return nested;
    }
    if (command === 'eval' && args.length > 0) {
      const nested = checkBashCommand(args.join(' '), ctx, depth + 1);
      if (nested) return nested;
    }
  }

  const isSpikeRun =
    command === 'node' && args[0] === SPIKE_ENV_FLAG && SPIKE_SCRIPT.test(args[1] ?? '');
  const secret = rest.find(
    (token, index) =>
      SECRET_FILE.test(token) &&
      !SECRET_EXAMPLE.test(token) &&
      !(isSpikeRun && index === 1 && token === SPIKE_ENV_FLAG)
  );
  if (secret) {
    return `"${secret}" looks like a secrets file. Never open or reference .env files or keys; only .env.example is allowed.`;
  }

  return null;
}

/**
 * @param {string} command Bash command text
 * @param {{ projectDir: string, cwd: string, homeDir: string, tmpRoots: string[] }} ctx
 * @returns {string | null}
 */
export function checkBashCommand(command, ctx, depth = 0) {
  for (const segment of command.split(SEGMENT_SEPARATOR)) {
    const reason = checkSegment(segment, ctx, depth);
    if (reason) return reason;
  }
  return null;
}
