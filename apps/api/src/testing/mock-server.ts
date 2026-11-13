import { http, passthrough } from 'msw';
import { setupServer } from 'msw/node';

import { loadEnv } from '../config/config.module.js';

// Tests never reach the network (see `vitest.setup.ts`). The exceptions are the loopback address
// (route tests talk to the app under test through a local port: supertest) and the local AWS
// emulator that the db specs use, which runs on this machine.
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+\//;
const { AWS_ENDPOINT_URL } = loadEnv();

/** The MSW server of every test file; specs add their handlers with `server.use(...)`. */
export const server = setupServer(
  http.all(LOOPBACK, () => passthrough()),
  ...(AWS_ENDPOINT_URL === undefined
    ? []
    : [http.all(`${AWS_ENDPOINT_URL}/*`, () => passthrough())])
);
