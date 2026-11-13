import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { KeycloakAdminClient } from './adapters/keycloak-admin.client.js';
import { DemoController } from './demo.controller.js';
import { DemoService } from './demo.service.js';
import { KEYCLOAK_ADMIN, type KeycloakAdmin } from './domain/demo-user.js';

@Module({
  controllers: [DemoController],
  providers: [
    {
      provide: KEYCLOAK_ADMIN,
      useFactory: (env: Env, clock: Clock) =>
        new KeycloakAdminClient(
          {
            baseUrl: env.KEYCLOAK_URL,
            realm: env.KEYCLOAK_REALM,
            clientId: env.KEYCLOAK_DEMO_CLIENT_ID,
            clientSecret: env.KEYCLOAK_DEMO_CLIENT_SECRET,
          },
          clock
        ),
      inject: [APP_CONFIG, CLOCK],
    },
    {
      provide: DemoService,
      useFactory: (db: Database, keycloak: KeycloakAdmin, clock: Clock, env: Env) =>
        new DemoService(db, keycloak, clock, env.DEMO_USER_TTL_SECONDS),
      inject: [DB, KEYCLOAK_ADMIN, CLOCK, APP_CONFIG],
    },
  ],
  exports: [DemoService],
})
export class DemoModule {}
