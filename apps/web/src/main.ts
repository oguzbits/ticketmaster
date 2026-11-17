import { bootstrapApplication } from '@angular/platform-browser';
import { HealthResponseSchema } from '@app/shared';
import { config } from 'zod';

import { App } from './app/app';
import { appConfig } from './app/app.config';

// The browser CSP intentionally omits `unsafe-eval`. Without `jitless`, Zod probes `new Function("")`
// on first parse and triggers a noisy CSP violation even though its fallback parser works fine.
config({ jitless: true });

async function bootstrapBrowserTracing(): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/health/live', { cache: 'no-store' });
  } catch (error) {
    // Tracing is optional; a transient fetch error before or during startup never blocks the app.
    void error;
    return;
  }
  if (!response.ok) return;
  const parsed = HealthResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.tracing !== true) return;
  const { startBrowserTracing } = await import('./app/telemetry/telemetry');
  startBrowserTracing();
}

// A bootstrap failure stays an unhandled rejection: the browser reports it, nothing hides it.
await bootstrapApplication(App, appConfig);
void bootstrapBrowserTracing();
