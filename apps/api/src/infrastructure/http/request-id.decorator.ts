import { AUDIT_LOG_LIMITS } from '@app/shared';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/** The part of the request pino-http annotates (`genReqId`, see `logging/request-id.ts`). */
interface LoggedRequest {
  id?: string | number | object;
}

/**
 * The request ID, cut to the audit column's limit: `requestId` already limits a client's value to the
 * column's length; the cut keeps any other source of `req.id` from failing the change it belongs to. Throws without an ID (no logger ran).
 */
export function requestIdOf(req: LoggedRequest): string {
  if (typeof req.id !== 'string' || req.id === '') {
    throw new Error('the request has no ID: the HTTP logger did not run');
  }
  return req.id.slice(0, AUDIT_LOG_LIMITS.REQUEST_ID_MAX);
}

export const RequestId = createParamDecorator((_data: undefined, context: ExecutionContext) =>
  requestIdOf(context.switchToHttp().getRequest<LoggedRequest>())
);
