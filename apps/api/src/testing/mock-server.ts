import { http, passthrough } from 'msw';
import { setupServer } from 'msw/node';

import { loadEnv } from '../config/config.module.js';

// Tests never reach the network (see `vitest.setup.ts`). The exceptions are the loopback address
// (route tests talk to the app under test through a local port: supertest) and the local AWS
// emulator and the local mail sink (Mailpit, read through its REST API) that the db specs use, which
// run on this machine.
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+\//;
const { AWS_ENDPOINT_URL } = loadEnv();
/** Origin of the local Mailpit; its REST API is under `/api/v1`. */
export const LOCAL_MAILPIT_ORIGIN = 'http://localhost:8025';

/** The MSW server of every test file; specs add their handlers with `server.use(...)`. */
export const server = setupServer(
  http.all(LOOPBACK, () => passthrough()),
  ...(AWS_ENDPOINT_URL === undefined
    ? []
    : [http.all(`${AWS_ENDPOINT_URL}/*`, () => passthrough())]),
  http.all(`${LOCAL_MAILPIT_ORIGIN}/*`, () => passthrough())
);
