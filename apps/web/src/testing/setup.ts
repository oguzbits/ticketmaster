import { afterEach } from 'vitest';

// A session stored by one test must not log the next one in.
afterEach(() => sessionStorage.clear());
