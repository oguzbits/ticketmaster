import { loadEnv } from './config/config.module.js';
import { SERVICE_NAME, startTelemetry } from './infrastructure/telemetry/index.js';

// Loaded by `node --import` before `main.js`, so the hooks exist before the app imports Express.
// Tracing and metrics both off: nothing is registered or imported.
await startTelemetry(loadEnv(), { serviceName: SERVICE_NAME.API });
