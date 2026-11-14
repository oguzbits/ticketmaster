import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { APP_CONFIG } from './config/config.module.js';
import type { Env } from './config/env.js';

/** Probes stay at the root: the container health check and the proxy call them without /api. */
export const UNPREFIXED_ROUTES = ['health/live', 'health/ready'];

/** One proxy hop sits in front of the API (Caddy), so `req.ip` is the address Caddy saw. */
const TRUSTED_PROXY_HOPS = 1;

export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api', { exclude: UNPREFIXED_ROUTES });
  app.use(helmet());
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
  const { CORS_ORIGIN } = app.get<Env>(APP_CONFIG);
  if (CORS_ORIGIN !== undefined) {
    // A list is matched exactly and answers no header for another origin; a plain string would be
    // echoed to every caller.
    app.enableCors({
      origin: [new URL(CORS_ORIGIN).origin],
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type'],
    });
  }
  return app;
}
