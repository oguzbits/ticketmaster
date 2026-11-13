import { Module } from '@nestjs/common';

import { CLOCK, type Clock } from '../../core/clock.js';
import { BookingsModule, BookingsService } from '../bookings/index.js';
import { SimulationRunner } from './simulation-runner.js';
import { SimulationStreamService } from './simulation-stream.service.js';
import { SimulationsController } from './simulations.controller.js';
import { SimulationsService } from './simulations.service.js';

/** How often a running simulation reports its progress. */
const PROGRESS_INTERVAL_MS = 250;

@Module({
  imports: [BookingsModule],
  controllers: [SimulationsController],
  providers: [
    SimulationsService,
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
