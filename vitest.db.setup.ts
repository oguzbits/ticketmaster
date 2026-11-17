import './vitest.setup.js';

import { registerInfraPassthrough } from './apps/api/src/testing/mock-server.js';

// DB specs talk to the local AWS emulator and Mailpit across beforeAll, tests and afterAll; offline specs must not.
registerInfraPassthrough();
