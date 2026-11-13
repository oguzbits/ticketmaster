import { afterAll, afterEach, beforeAll } from 'vitest';

import { server } from './apps/api/src/testing/mock-server.js';

// Tests never reach the network. Any request without a handler fails the test.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
