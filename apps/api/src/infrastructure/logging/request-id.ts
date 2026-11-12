import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** The caller's `x-request-id` when it sends one, otherwise a fresh UUID. */
export function requestId(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  return typeof header === 'string' && header !== '' ? header : randomUUID();
}
