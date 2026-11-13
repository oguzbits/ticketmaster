import {
  type DemoLoginRequest,
  DemoLoginRequestSchema,
  type RefreshRequest,
  RefreshRequestSchema,
  type TokenResponse,
} from '@app/shared';
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { RateLimit } from '../../infrastructure/rate-limit/rate-limit.decorator.js';
import { Public } from '../auth/index.js';
import { DemoService } from './demo.service.js';

@Controller()
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Public()
  @RateLimit('DEMO_LOGIN')
  @Post('demo-login')
  @HttpCode(HttpStatus.OK)
  login(@Body(new ZodPipe(DemoLoginRequestSchema)) body: DemoLoginRequest): Promise<TokenResponse> {
    return this.demo.login(body.role);
  }

  @Public()
  @RateLimit('REFRESH')
  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body(new ZodPipe(RefreshRequestSchema)) body: RefreshRequest): Promise<TokenResponse> {
    return this.demo.refresh(body.refreshToken);
  }
}
