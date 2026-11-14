import { loadEnv } from './config/config.module.js';

// Loaded by `node --import` before `main.js`, so the hooks exist before the app imports Express.
// Tracing off: nothing is registered or imported.
const env = loadEnv();
if (env.TRACING_ENABLED) {
  const { register } = await import('import-in-the-middle/register-hooks.mjs');
  register();
  const { SERVICE_NAME, startTracing } = await import('./infrastructure/tracing/index.js');
  const tracing = startTracing(env, { serviceName: SERVICE_NAME.API });
  // Spans reach the exporter only when the provider shuts down.
  process.once('SIGTERM', () => void tracing?.shutdown());
}
