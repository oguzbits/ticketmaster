import { loadEnv } from '@app/api/config';

// Loaded by `node --import` before `main.js`; see apps/api/src/tracing.preload.ts.
const env = loadEnv();
if (env.TRACING_ENABLED || env.METRICS_ENABLED) {
  const { register } = await import('import-in-the-middle/register-hooks.mjs');
  register();
  const { SERVICE_NAME, startTracing } = await import('@app/api/tracing');
  const { startMetrics } = await import('@app/api/metrics');
  const tracing = startTracing(env, { serviceName: SERVICE_NAME.WORKER });
  const metrics = startMetrics(env, { serviceName: SERVICE_NAME.WORKER });
  process.once('SIGTERM', () => void Promise.all([tracing?.shutdown(), metrics?.shutdown()]));
}
