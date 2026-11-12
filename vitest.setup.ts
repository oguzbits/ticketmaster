import { http, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

// Tests never reach the network. Any request without a handler fails the test. The one exception is
// the loopback address: route tests talk to the app under test through a local port (supertest).
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+\//;

export const server = setupServer(http.all(LOOPBACK, () => passthrough()));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
