import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CLOCK, type Clock } from '../../core/clock.js';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { AuditModule, AuditService } from '../audit/index.js';
import { BookingsModule, BookingsService } from '../bookings/index.js';
import { SimulationRunner } from './simulation-runner.js';
import { SimulationStreamService } from './simulation-stream.service.js';
import { SimulationsController } from './simulations.controller.js';
import { SIMULATION_DEPS, type SimulationDeps, SimulationsService } from './simulations.service.js';

/** How often a running simulation reports its progress. */
const PROGRESS_INTERVAL_MS = 250;

@Module({
  imports: [AuditModule, BookingsModule, RateLimitModule],
  controllers: [SimulationsController],
  providers: [
    SimulationsService,
    {
      provide: SIMULATION_DEPS,
      useFactory: (env: Env, audit: AuditService): SimulationDeps => ({ env, audit }),
      inject: [APP_CONFIG, AuditService],
    },
    SimulationStreamService,
    {
      provide: SimulationRunner,
      // Math.random belongs here, in the wiring: the runner takes them as inputs.
      useFactory: (bookings: BookingsService, clock: Clock) =>
        new SimulationRunner({
          bookings,
          clock,
          random: Math.random,
          intervalMs: PROGRESS_INTERVAL_MS,
        }),
      inject: [BookingsService, CLOCK],
    },
  ],
  exports: [SimulationsService, SimulationRunner],
})
export class SimulationsModule {}
