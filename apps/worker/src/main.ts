import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { startWatchdog, WATCHDOG_BEAT_MS, WATCHDOG_STALE_MS } from './watchdog.js';
import { WorkerModule } from './worker.module.js';

// A standalone application context: the worker has no HTTP server. Consumers and scheduled jobs
// register in WorkerModule and keep the process alive.
const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
app.enableShutdownHooks();
// Last: a hung worker is killed and the restart policy brings it back (see watchdog.ts).
startWatchdog({ staleMs: WATCHDOG_STALE_MS, beatMs: WATCHDOG_BEAT_MS });
