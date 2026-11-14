import type { Env } from '../../config/env.js';
import { SERVICE_NAME, type ServiceName } from '../tracing/service-name.js';

export { SERVICE_NAME };

export interface TelemetryOptions {
  serviceName: ServiceName;
  /** Where SIGTERM arrives; the process, unless a spec passes its own emitter. */
  signals?: { once(event: 'SIGTERM', listener: () => void): void };
}

/**
 * What both preloads do, in one place: with tracing or metrics on, register the ESM hooks before
 * the app imports Express, start the SDK parts that are on (tracing first: metrics hands its meter
 * provider to the instrumentations tracing registered) and stop them on SIGTERM. With both off
 * nothing is imported, registered or listened for. Spans reach the exporter only when the
 * provider shuts down, which is why SIGTERM matters.
 */
export async function startTelemetry(
  env: Pick<
    Env,
    | 'TRACING_ENABLED'
    | 'TRACING_OTLP_ENDPOINT'
    | 'METRICS_ENABLED'
    | 'METRICS_PORT'
    | 'METRICS_HOST'
  >,
  options: TelemetryOptions
): Promise<void> {
  if (!env.TRACING_ENABLED && !env.METRICS_ENABLED) return;

  const { register } = await import('import-in-the-middle/register-hooks.mjs');
  register();
  const { startTracing } = await import('../tracing/index.js');
  const { startMetrics } = await import('../metrics/index.js');
  const tracing = startTracing(env, { serviceName: options.serviceName });
  const metrics = startMetrics(env, { serviceName: options.serviceName });
  (options.signals ?? process).once(
    'SIGTERM',
    () => void Promise.all([tracing?.shutdown(), metrics?.shutdown()])
  );
}
