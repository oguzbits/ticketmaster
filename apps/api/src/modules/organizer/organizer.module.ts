import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CLOCK, type Clock } from '../../core/clock.js';
import { AuditModule, AuditService } from '../audit/index.js';
import { EventCache, EventCacheModule } from '../event-cache/index.js';
import { OrganizerController } from './organizer.controller.js';
import { ORGANIZER_DEPS, type OrganizerDeps, OrganizerService } from './organizer.service.js';

@Module({
  imports: [AuditModule, EventCacheModule],
  controllers: [OrganizerController],
  providers: [
    OrganizerService,
    {
      provide: ORGANIZER_DEPS,
      useFactory: (
        clock: Clock,
        audit: AuditService,
        eventCache: EventCache,
        env: Env
      ): OrganizerDeps => ({ clock, audit, eventCache, env }),
      inject: [CLOCK, AuditService, EventCache, APP_CONFIG],
    },
  ],
})
export class OrganizerModule {}
