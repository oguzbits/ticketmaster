import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker.module.js';

// A standalone application context: the worker has no HTTP server. Consumers and scheduled jobs
// register in WorkerModule and keep the process alive.
const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
