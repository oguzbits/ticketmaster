#!/usr/bin/env node

/**
 * Docs audit.
 *
 * Fails when a Markdown file links to a missing file or anchor, names a `pnpm` script that no
 * package.json defines, names a path under apps/, packages/ or deploy/ that does not exist,
 * contains an absolute machine path, or states a test count ("1179 Tests"). The stable documents
 * (docs/PLAN.md) also may not carry a date or a word about what is built, removed or done.
 * Fenced code blocks are skipped, except for the absolute-path rule.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'reports', 'results']);
const PNPM_BUILTINS = new Set([
  'install',
  'add',
  'remove',
  'update',
  'run',
  'exec',
  'dlx',
  'audit',
]);
const PNPM_FLAGS_WITH_VALUE = new Set(['--filter', '-F']);
const PATH_ROOTS = ['apps/', 'packages/', 'deploy/'];
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const ABSOLUTE_PATH = /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/;
const TEST_COUNT = /\b\d[\d.]*\s+tests\b/i;
const FENCE = /^\s*```/;
// Documents that hold context, not state: a date or a word about what is built goes stale unnoticed.
const STABLE_DOCS = new Set(['docs/PLAN.md']);
// "Definition of Done" names a rule, not a state.
const STATE_WORD =
  /\b(\d{4}-\d{2}-\d{2}|built|removed|implemented|added later|as of \d|(?<!definition of )done\b)/i;

function collectMarkdown(root, dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : collectMarkdown(root, full);
    return entry.name.endsWith('.md') ? [path.relative(root, full)] : [];
  });
}

function collectScripts(root) {
  const manifests = ['package.json'];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(root, group);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) manifests.push(path.join(group, name, 'package.json'));
  }
  const scripts = new Set();
  for (const manifest of manifests) {
    const file = path.join(root, manifest);
    if (!fs.existsSync(file)) continue;
    for (const name of Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).scripts ?? {})) {
      scripts.add(name);
    }
  }
  return scripts;
}

// GitHub's slug rule: lower case, drop punctuation, spaces to hyphens, repeats get a counter.
function collectAnchors(content) {
  const seen = new Map();
  const anchors = new Set();
  let fenced = false;
  for (const line of content.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = !fenced && /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (!heading) continue;
    const slug = heading[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

function pnpmScriptName(command) {
  const words = command.trim().split(/\s+/).slice(1);
  for (let i = 0; i < words.length; i += 1) {
    if (PNPM_FLAGS_WITH_VALUE.has(words[i])) i += 1;
    else if (!words[i].startsWith('-')) return words[i];
  }
  return undefined;
}

export function auditDocs(root) {
  const scripts = collectScripts(root);
  const violations = [];
  const anchorCache = new Map();
  const anchorsOf = (file) => {
    if (!anchorCache.has(file)) {
      anchorCache.set(file, collectAnchors(fs.readFileSync(path.join(root, file), 'utf8')));
    }
    return anchorCache.get(file);
  };

  for (const file of collectMarkdown(root)) {
    let fenced = false;
    fs.readFileSync(path.join(root, file), 'utf8')
      .split('\n')
      .forEach((text, index) => {
        const report = (message) => violations.push({ file, line: index + 1, message });
        const machinePath = ABSOLUTE_PATH.exec(text);
        if (machinePath) report(`absolute machine path ${machinePath[0]} (use a relative link)`);
        if (FENCE.test(text)) fenced = !fenced;
        if (fenced || FENCE.test(text)) return;

        for (const [, href] of text.matchAll(LINK)) {
          if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
          const [target, anchor] = href.split('#');
          const resolved = target ? path.join(path.dirname(file), target) : file;
          if (!fs.existsSync(path.join(root, resolved))) {
            report(`link target does not exist: ${href}`);
          } else if (anchor && resolved.endsWith('.md') && !anchorsOf(resolved).has(anchor)) {
            report(`link anchor does not exist: ${href}`);
          }
        }

        if (STABLE_DOCS.has(file) && STATE_WORD.test(text)) {
          report(
            `state in a stable document (put it in BACKLOG.md or leave it to git): ${STATE_WORD.exec(text)[0]}`
          );
        }
        if (TEST_COUNT.test(text)) {
          report(`test count in docs (run the command instead): ${TEST_COUNT.exec(text)[0]}`);
        }

        for (const [, code] of text.matchAll(INLINE_CODE)) {
          if (code.startsWith('pnpm ')) {
            const name = pnpmScriptName(code);
            if (name && !PNPM_BUILTINS.has(name) && !scripts.has(name)) {
              report(`pnpm script not found in any package.json: ${name}`);
            }
          } else if (PATH_ROOTS.some((prefix) => code.startsWith(prefix))) {
            const candidate = code.replace(/:\d+(-\d+)?$/, '');
            if (!/[*<>{}\s]/.test(candidate) && !fs.existsSync(path.join(root, candidate))) {
              report(`path does not exist: ${candidate}`);
            }
          }
        }
      });
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = auditDocs(process.cwd());
  if (violations.length > 0) {
    process.stderr.write('Docs audit failed:\n');
    for (const v of violations) process.stderr.write(`  ${v.file}:${v.line}  ${v.message}\n`);
    process.exit(1);
  }
  process.stdout.write('audit:docs ok\n');
}
