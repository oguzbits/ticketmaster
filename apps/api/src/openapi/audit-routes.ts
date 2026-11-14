/**
 * The route of the audit log, in a table of its own: `routes.ts` is at the line limit. The spec and
 * `scripts/docs/generate.mjs` merge it with `ROUTES`. Like `routes.ts`, Node runs this file
 * directly, so it imports only packages (the type import is erased).
 */

import { ROLE } from '@app/shared';

import type { RouteDoc } from './routes.js';

export const AUDIT_ROUTES: Record<string, RouteDoc> = {
  'AuditController.list': {
    method: 'get',
    path: '/api/audit-log',
    summary: 'Read the audit log',
    access: [ROLE.ADMIN],
    success: {
      status: 200,
      description:
        'One page, newest first. Query: `action`, `actorId`, `cursor` (the `nextCursor` of the previous page), `limit` (1 to 100, default 50).',
      schema: 'AuditLogPage',
    },
    errors: { 400: 'A malformed query parameter (cursor, limit, action or actorId).' },
  },
};
