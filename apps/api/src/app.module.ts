import { Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './modules/health/index.js';

@Module({ imports: [ConfigModule, HealthModule] })
export class AppModule {}
