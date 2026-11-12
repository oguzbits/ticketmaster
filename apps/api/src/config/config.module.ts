import { Global, Module } from '@nestjs/common';

import { type Env, parseEnv } from './env.js';

/** Injection token of the validated environment. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** The only call that reads `process.env`; the app, the migration script and the tests use it. */
export function loadEnv(): Env {
  return parseEnv(process.env);
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: loadEnv }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
