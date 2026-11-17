import { http, passthrough } from 'msw';
import { setupServer } from 'msw/node';

import { loadEnv } from '../config/config.module.js';

// Offline tests never reach the network (see `vitest.setup.ts`). Loopback stays open so route
// tests can call the app under test over a local port (supertest).
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+\//;
/** Origin of the local Mailpit; its REST API is under `/api/v1`. */
export const LOCAL_MAILPIT_ORIGIN = 'http://localhost:8025';

/** The MSW server of every test file; specs add their handlers with `server.use(...)`. */
const baseHandlers = [http.all(LOOPBACK, () => passthrough())];
export const server = setupServer(...baseHandlers);

/**
 * Allows `db` specs to reach the local AWS emulator and Mailpit across `beforeAll`, tests and
 * `afterAll`. Called from `vitest.db.setup.ts` so offline specs still fail if they try to call
 * either.
 */
export function registerInfraPassthrough(): void {
  const { AWS_ENDPOINT_URL } = loadEnv();
  const infraHandlers = [http.all(`${LOCAL_MAILPIT_ORIGIN}/*`, () => passthrough())];
  if (AWS_ENDPOINT_URL !== undefined) {
    infraHandlers.push(http.all(`${AWS_ENDPOINT_URL}/*`, () => passthrough()));
  }
  server.resetHandlers(...baseHandlers, ...infraHandlers);
}
