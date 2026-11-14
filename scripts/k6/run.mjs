#!/usr/bin/env node

/**
 * Load run: starts the Compose stack under its own project name (so `down --volumes` never
 * touches the development volume) with the load-test override, then runs the named k6 scenarios
 * in the k6 container. The stack stays up for the next run; `docker compose down --volumes` with
 * the same environment (docs/load-tests.md) removes it and gives the next run a fresh database.
 * Exits with 1 when a scenario misses a threshold.
 */

import { spawnSync } from 'node:child_process';

const SCENARIOS = ['browse', 'booking-flow', 'rush', 'waiting-room'];
const target = process.argv[2];

if (target !== 'all' && !SCENARIOS.includes(target)) {
  console.error(`Usage: pnpm load <${[...SCENARIOS, 'all'].join('|')}>`);
  process.exit(2);
}

const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: 'ticketmaster-klon-load',
  COMPOSE_FILE: 'docker-compose.yml:docker-compose.loadtest.yml',
};

function run(command, args) {
  return spawnSync(command, args, { stdio: 'inherit', env }).status ?? 1;
}

if (run('docker', ['compose', 'up', '--detach', '--build', '--wait']) !== 0) {
  run('docker', ['compose', 'logs', '--no-color', '--tail', '100']);
  process.exit(1);
}
// A missed threshold in one scenario does not hide the results of the others.
let status = 0;
for (const name of target === 'all' ? SCENARIOS : [target]) {
  const code = run('docker', [
    'compose',
    '--profile',
    'loadtest',
    'run',
    '--rm',
    'k6',
    'run',
    // No progress bar: it fills a log with one line per second.
    '--quiet',
    `/scripts/${name}.js`,
  ]);
  status ||= code;
}
process.exit(status);
