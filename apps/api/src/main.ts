import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { APP_CONFIG } from './config/config.module.js';
import type { Env } from './config/env.js';

const app = configureApp(
  await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true })
);
// SIGTERM closes the HTTP server and runs the modules' shutdown hooks before the process exits.
app.enableShutdownHooks();
await app.listen(app.get<Env>(APP_CONFIG).PORT);
