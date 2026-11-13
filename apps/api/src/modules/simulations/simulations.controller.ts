import {
  ROLE,
  type SimulationRun,
  type StartSimulationRequest,
  StartSimulationRequestSchema,
} from '@app/shared';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';

import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator.js';
import { type AuthUser, CurrentUser, Public, Roles } from '../auth/index.js';
import { SimulationsService } from './simulations.service.js';

@Controller('simulations')
export class SimulationsController {
  constructor(private readonly simulations: SimulationsService) {}

  @Roles(ROLE.ADMIN)
  @RateLimit('SIMULATION')
  @Post()
  start(
    @Body(new ZodPipe(StartSimulationRequestSchema)) body: StartSimulationRequest,
    @CurrentUser() user: AuthUser
  ): Promise<SimulationRun> {
    return this.simulations.start(body, user.id);
  }

  @Roles(ROLE.ADMIN)
  @Get()
  list(): Promise<SimulationRun[]> {
    return this.simulations.listFinished();
  }

  /** Public by run ID: a random UUID, and the answer holds aggregate numbers only. */
  @Public()
  @Get(':id')
  get(@Param('id', new ZodPipe(z.uuid())) id: string): Promise<SimulationRun> {
    return this.simulations.find(id);
  }
}
