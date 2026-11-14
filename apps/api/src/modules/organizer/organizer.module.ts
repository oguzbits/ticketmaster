import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/index.js';
import { OrganizerController } from './organizer.controller.js';
import { OrganizerService } from './organizer.service.js';

@Module({
  imports: [AuditModule],
  controllers: [OrganizerController],
  providers: [OrganizerService],
})
export class OrganizerModule {}
