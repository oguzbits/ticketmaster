import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import {
  BookingsModule,
  SEAT_CHANGE_PUBLISHER,
  type SeatChangePublisher,
} from '../bookings/index.js';
import { KeycloakAdminClient } from './adapters/keycloak-admin.client.js';
import { DemoController } from './demo.controller.js';
import { DEMO_OPTIONS, type DemoOptions, DemoService, MAX_DEMO_USERS } from './demo.service.js';
import { KEYCLOAK_ADMIN, type KeycloakAdmin } from './domain/demo-user.js';

@Module({
  imports: [BookingsModule],
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
      provide: DEMO_OPTIONS,
      useFactory: (env: Env, seatChanges: SeatChangePublisher): DemoOptions => ({
        userTtlSeconds: env.DEMO_USER_TTL_SECONDS,
        maxUsers: MAX_DEMO_USERS,
        seatChanges,
      }),
      inject: [APP_CONFIG, SEAT_CHANGE_PUBLISHER],
    },
    {
      provide: DemoService,
      useFactory: (db: Database, keycloak: KeycloakAdmin, clock: Clock, options: DemoOptions) =>
        new DemoService(db, keycloak, clock, options),
      inject: [DB, KEYCLOAK_ADMIN, CLOCK, DEMO_OPTIONS],
    },
  ],
  exports: [DemoService],
})
export class DemoModule {}
