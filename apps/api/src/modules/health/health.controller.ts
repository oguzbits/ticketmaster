import { HEALTH_STATUS, type HealthResponse } from '@app/shared';
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  live(): HealthResponse {
    return { status: HEALTH_STATUS.UP };
  }
}
