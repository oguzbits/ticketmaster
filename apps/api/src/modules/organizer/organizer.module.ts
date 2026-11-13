import { Module } from '@nestjs/common';

import { OrganizerController } from './organizer.controller.js';
import { OrganizerService } from './organizer.service.js';

@Module({ controllers: [OrganizerController], providers: [OrganizerService] })
export class OrganizerModule {}
