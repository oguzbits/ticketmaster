import { bootstrapApplication } from '@angular/platform-browser';
import { z } from 'zod';

import { App } from './app/app';
import { appConfig } from './app/app.config';

// The browser CSP intentionally omits `unsafe-eval`. Without `jitless`, Zod probes `new Function("")`
// on first parse and triggers a noisy CSP violation even though its fallback parser works fine.
z.config({ jitless: true });

// A bootstrap failure stays an unhandled rejection: the browser reports it, nothing hides it.
await bootstrapApplication(App, appConfig);
