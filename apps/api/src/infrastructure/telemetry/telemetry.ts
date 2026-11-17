import type { Env } from '../../config/env.js';
import { SERVICE_NAME, type ServiceName } from '../tracing/service-name.js';

export { SERVICE_NAME };

interface SignalTarget {
  once(event: 'SIGTERM', listener: () => void): void;
  removeListener(event: 'SIGTERM', listener: () => void): void;
}

export interface TelemetryOptions {
  serviceName: ServiceName;
  /** Where SIGTERM arrives; the process, unless a spec passes its own emitter. */
  signals?: SignalTarget;
}

let activeShutdown: (() => Promise<void>) | undefined;
let fallbackSignal: { target: SignalTarget; listener: () => void } | undefined;

function detachFallbackSignal(): void {
  if (fallbackSignal === undefined) return;
  fallbackSignal.target.removeListener('SIGTERM', fallbackSignal.listener);
  fallbackSignal = undefined;
}

/**
 * Hands shutdown responsibility to Nest (`TelemetryModule.onApplicationShutdown`) so a SIGTERM
 * does not flush and stop the telemetry providers while HTTP requests or queue handlers are still
 * draining. Before Nest reaches `onModuleInit` (or if bootstrap fails), the SIGTERM fallback stays
 * armed.
 */
export function claimTelemetryLifecycle(): void {
  detachFallbackSignal();
}

/** Flushes and closes any running tracing and metrics providers. Idempotent. */
export async function shutdownTelemetry(): Promise<void> {
  detachFallbackSignal();
  const stop = activeShutdown;
  activeShutdown = undefined;
  await stop?.();
}

/**
 * What both preloads do, in one place: with tracing or metrics on, register the ESM hooks before
 * the app imports Express, start the SDK parts that are on (tracing first: metrics hands its meter
 * provider to the instrumentations tracing registered) and stop them on Nest shutdown (with a
 * SIGTERM fallback if bootstrap has not claimed the lifecycle yet). With both off nothing is
 * imported, registered or listened for. Spans reach the exporter only when the provider shuts down.
 */
export async function startTelemetry(
  env: Pick<
    Env,
    | 'TRACING_ENABLED'
    | 'TRACING_OTLP_ENDPOINT'
    | 'TRACING_SAMPLE_RATIO'
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

  activeShutdown = async () => {
    await Promise.all([tracing?.shutdown(), metrics?.shutdown()]);
  };

  const target = options.signals ?? process;
  const listener = (): void => {
    void shutdownTelemetry();
  };
  detachFallbackSignal();
  fallbackSignal = { target, listener };
  target.once('SIGTERM', listener);
}
