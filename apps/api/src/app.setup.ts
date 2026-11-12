import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

/** Probes stay at the root: the container health check and the proxy call them without /api. */
const UNPREFIXED_ROUTES = ['health/live', 'health/ready'];

export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api', { exclude: UNPREFIXED_ROUTES });
  return app;
}
