import { http, passthrough } from 'msw';
import { setupServer } from 'msw/node';

// Tests never reach the network (see `vitest.setup.ts`). The one exception is the loopback
// address: route tests talk to the app under test through a local port (supertest).
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+\//;

/** The MSW server of every test file; specs add their handlers with `server.use(...)`. */
export const server = setupServer(http.all(LOOPBACK, () => passthrough()));
