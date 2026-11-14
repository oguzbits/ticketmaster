import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { AUDIT_LOG_LIMITS } from '@app/shared';
import { z } from 'zod';

// A character set that cannot carry an email address, a name or a free-text value: the ID lands
// in the append-only audit log and in every log line.
const ClientRequestIdSchema = z
  .string()
  .max(AUDIT_LOG_LIMITS.REQUEST_ID_MAX)
  .regex(/^[A-Za-z0-9._-]+$/);

/** The caller's `x-request-id` when it is a plain token (letters, digits, `.`, `_`, `-`), otherwise a fresh UUID. */
export function requestId(req: IncomingMessage): string {
  const parsed = ClientRequestIdSchema.safeParse(req.headers['x-request-id']);
  return parsed.success ? parsed.data : randomUUID();
}
