import { loadEnv } from '@app/api/config';
import { SERVICE_NAME, startTelemetry } from '@app/api/telemetry';

// Loaded by `node --import` before `main.js`; see apps/api/src/tracing.preload.ts.
await startTelemetry(loadEnv(), { serviceName: SERVICE_NAME.WORKER });
