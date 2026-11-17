import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { startWatchdog } from './watchdog.js';

// The watchdog kills `targetPid`; a throwaway `sleep` stands in for the worker process.
function spawnTarget() {
  const child = spawn('sleep', ['60']);
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.on('exit', (_code, signal) => resolve(signal))
  );
  return { child, exited };
}

describe('startWatchdog', () => {
  it('kills the process when nobody beats within staleMs', async () => {
    const { child, exited } = spawnTarget();
    const watchdog = startWatchdog({ staleMs: 200, beatMs: 60_000, targetPid: child.pid ?? 0 });
    try {
      expect(await exited).toBe('SIGKILL');
    } finally {
      watchdog.stop();
      child.kill();
    }
  });

  it('leaves the process alone while it keeps beating', async () => {
    const { child, exited } = spawnTarget();
    const watchdog = startWatchdog({ staleMs: 200, beatMs: 20, targetPid: child.pid ?? 0 });
    try {
      const outcome = await Promise.race([exited, sleep(800).then(() => 'ALIVE')]);
      expect(outcome).toBe('ALIVE');
    } finally {
      watchdog.stop();
      child.kill();
    }
  });
});
