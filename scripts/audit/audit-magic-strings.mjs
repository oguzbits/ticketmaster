#!/usr/bin/env node

/**
 * Magic-string audit.
 *
 * Finds every `export const NAME = { ... } as const` dictionary, collects its UPPER_SNAKE values
 * and fails if such a value appears as a raw string literal outside the declaring file.
 * Constants must be imported, in production code and in tests alike.
 */

import fs from 'node:fs';
import path from 'node:path';

const SCAN_DIRS = ['apps', 'packages', 'e2e'];
const EXTENSIONS = ['.ts', '.tsx', '.mjs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);
const ENUM_VALUE = /^[A-Z][A-Z0-9_]{2,}$/;
const DICTIONARY = /export\s+const\s+[A-Z][A-Z0-9_]*\s*=\s*\{([\s\S]*?)\}\s*as\s+const/g;
const STRING_VALUE = /:\s*(['"`])([^'"`]+)\1/g;

function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : collectFiles(full);
    return EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
  });
}

const files = SCAN_DIRS.flatMap(collectFiles).map((file) => ({
  file,
  content: fs.readFileSync(file, 'utf8'),
}));

// value -> file that declares it
const declaredIn = new Map();
for (const { file, content } of files) {
  for (const dictionary of content.matchAll(DICTIONARY)) {
    for (const pair of dictionary[1].matchAll(STRING_VALUE)) {
      const value = pair[2].trim();
      if (ENUM_VALUE.test(value)) declaredIn.set(value, file);
    }
  }
}

const violations = [];
for (const { file, content } of files) {
  content.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const [value, declaringFile] of declaredIn) {
      if (declaringFile === file) continue;
      if (new RegExp(`(['"\`])${value}\\1`).test(line)) {
        violations.push({ file, line: index + 1, value, text: trimmed });
      }
    }
  });
}

if (violations.length > 0) {
  process.stderr.write('Magic string violations: import the `as const` dictionary instead.\n');
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}  '${v.value}'\n    ${v.text}\n`);
  }
  process.exit(1);
}

process.stdout.write(`audit:magic ok (${declaredIn.size} constants checked)\n`);
