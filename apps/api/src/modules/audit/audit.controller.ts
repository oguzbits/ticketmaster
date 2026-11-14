import { type AuditLogPage, type AuditLogQuery, AuditLogQuerySchema, ROLE } from '@app/shared';
import { Controller, Get, Query } from '@nestjs/common';

import { ZodPipe } from '../../infrastructure/http/zod.pipe.js';
import { Roles } from '../auth/index.js';
import { AuditService } from './audit.service.js';

@Controller('audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Roles(ROLE.ADMIN)
  @Get()
  list(@Query(new ZodPipe(AuditLogQuerySchema)) query: AuditLogQuery): Promise<AuditLogPage> {
    return this.audit.list(query);
  }
}
