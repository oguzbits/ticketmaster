import { Module } from '@nestjs/common';

import { OutboxModule } from '../outbox/index.js';
import { HealthController } from './health.controller.js';

@Module({ imports: [OutboxModule], controllers: [HealthController] })
export class HealthModule {}
