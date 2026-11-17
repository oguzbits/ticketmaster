import { Worker } from 'node:worker_threads';

/** The worker is killed when its event loop has not beaten for this long. */
export const WATCHDOG_STALE_MS = 30_000;
/** How often the event loop beats; far below the stale limit. */
export const WATCHDOG_BEAT_MS = 1_000;

// Runs on its own thread, so it still ticks while the main event loop is blocked.
const WATCHDOG_THREAD = `
import { workerData } from 'node:worker_threads';
const { counter, staleMs, pid, signal } = workerData;
let last = Atomics.load(counter, 0);
let changedAt = Date.now();
setInterval(() => {
  const now = Atomics.load(counter, 0);
  if (now !== last) {
    last = now;
    changedAt = Date.now();
  } else if (Date.now() - changedAt >= staleMs) {
    process.stderr.write('{"level":60,"msg":"event loop stalled, killing the process"}\\n');
    process.kill(pid, signal);
  }
}, Math.max(staleMs / 4, 10));
`;

/**
 * Kills the process (SIGKILL, so the restart policy brings it back) when its event loop stops
 * beating: a hung worker is alive but does nothing, and a container restart policy only reacts to
 * an exit. Covers a blocked event loop only; stuck async work shows up in the outbox and gauge alerts.
 */
export function startWatchdog(options: { staleMs: number; beatMs: number; targetPid?: number }): {
  stop: () => void;
} {
  const counter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  // A data URL is always an ES module, whatever module type the parent package has.
  const thread = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(WATCHDOG_THREAD)}`),
    {
      workerData: {
        counter,
        staleMs: options.staleMs,
        pid: options.targetPid ?? process.pid,
        signal: 'SIGKILL',
      },
    }
  );
  thread.unref();
  const beat = setInterval(() => Atomics.add(counter, 0, 1), options.beatMs);
  beat.unref();
  return {
    stop: () => {
      clearInterval(beat);
      void thread.terminate();
    },
  };
}
