#!/usr/bin/env node

/**
 * Docs map audit. `docs/docs-map.json` binds code paths (a file, or a folder ending in `/`) to the
 * document that describes them (a file, or a folder ending in `/` when any document in it counts).
 * A change to such a path must change the document in the same
 * commit, or the message must say `Docs: n/a, <reason>`. This makes someone look; it does not
 * prove the text is true.
 *
 *   --message <file>   check the staged changes against the message in <file> (commit-msg hook)
 *   --range <a..b>     check every commit of a range (CI)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAP_FILE = 'docs/docs-map.json';
const WAIVER = /^Docs: n\/a,\s*\S/m;

/** Violations for one commit: `[{ path, doc }]` for every mapped path changed without its doc. */
export function missingDocs(map, changedFiles, message) {
  if (WAIVER.test(message)) return [];
  const matches = (entry) => (file) =>
    entry.endsWith('/') ? file.startsWith(entry) : file === entry;
  const missing = [];
  for (const [prefix, doc] of Object.entries(map)) {
    const touched = changedFiles.find(matches(prefix));
    if (touched && !changedFiles.some(matches(doc))) missing.push({ path: touched, doc });
  }
  return missing;
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

const lines = (text) => (text ? text.split('\n') : []);

// A mapping added later must not judge older commits, so each commit uses its own map.
function mapAt(root, hash) {
  const tracked = lines(git(root, 'ls-tree', '--name-only', hash, MAP_FILE));
  return tracked.length > 0 ? JSON.parse(git(root, 'show', `${hash}:${MAP_FILE}`)) : {};
}

/** Violations of every commit in a range: `[{ label, path, doc }]`. */
export function auditRange(root, range) {
  return lines(git(root, 'log', '--no-merges', '--format=%H', range)).flatMap((hash) => {
    const files = lines(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', hash));
    const message = git(root, 'log', '-1', '--format=%B', hash);
    return missingDocs(mapAt(root, hash), files, message).map((v) => ({
      label: hash.slice(0, 7),
      ...v,
    }));
  });
}

function main(argv) {
  const root = process.cwd();
  const option = (name) => argv[argv.indexOf(name) + 1];
  const violations = argv.includes('--range')
    ? auditRange(root, option('--range'))
    : missingDocs(
        JSON.parse(fs.readFileSync(path.join(root, MAP_FILE), 'utf8')),
        lines(git(root, 'diff', '--cached', '--name-only')),
        fs.readFileSync(option('--message'), 'utf8')
      ).map((v) => ({ label: 'staged changes', ...v }));
  for (const { label, path: changed, doc } of violations) {
    process.stderr.write(
      `${label}: ${changed} changed without ${doc} (update it or write "Docs: n/a, <reason>")\n`
    );
  }
  if (violations.length > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
