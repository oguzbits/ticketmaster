import { Global, Module } from '@nestjs/common';

import { type Env, parseEnv } from './env.js';

/** Injection token of the validated environment. The only place that reads `process.env`. */
export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): Env => parseEnv(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
