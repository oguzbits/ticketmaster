#!/usr/bin/env node

/**
 * End-to-end run: builds and starts the Compose stack under its own project name (so `down -v`
 * never touches the development volume), runs Playwright against it on port 8080 and tears the
 * stack down again. Exits with the status of the tests.
 */

import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: 'ticketmaster-klon-e2e',
  COMPOSE_FILE: 'docker-compose.yml:docker-compose.e2e.yml',
};

function run(command, args) {
  return spawnSync(command, args, { stdio: 'inherit', env }).status ?? 1;
}

// The specs import the dictionaries of @app/shared at runtime, so its dist must exist (a clean
// checkout, like CI, has none).
let status = run('pnpm', ['--filter', '@app/shared', 'build']);
if (status === 0) status = run('docker', ['compose', 'up', '--detach', '--build', '--wait']);
if (status === 0) status = run('pnpm', ['--filter', '@app/web', 'e2e']);
if (status !== 0) run('docker', ['compose', 'logs', '--no-color', '--tail', '100']);
run('docker', ['compose', 'down', '--volumes', '--remove-orphans']);
process.exit(status);
