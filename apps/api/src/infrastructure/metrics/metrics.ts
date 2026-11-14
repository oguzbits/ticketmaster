import { metrics } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, type MetricReader, type ViewOptions } from '@opentelemetry/sdk-metrics';

import type { Env } from '../../config/env.js';
import { acquireInstrumentation, type ServiceName, useMeterProvider } from '../tracing/index.js';
import { HTTP_ATTR, METRIC, ROUTE_UNMATCHED } from './names.js';

export interface MetricsHandle {
  shutdown(): Promise<void>;
}

const RESOURCE_SERVICE_NAME = 'service.name';
// The scraper is another container, so the listener cannot stay on localhost. Compose does not
// publish the port; a process started on a host exposes it to the network, and it holds no personal data.
const METRICS_HOST = '0.0.0.0';

/**
 * The request histogram carries exactly method, route template and status. The instrumentation
 * leaves `http.route` out when no route matched; that request gets one fixed value, so an unknown
 * URL never adds a series.
 */
const REQUEST_HISTOGRAM_VIEW: ViewOptions = {
  instrumentName: METRIC.HTTP_SERVER_DURATION,
  attributesProcessors: [
    {
      process: (incoming) => ({
        [HTTP_ATTR.METHOD]: incoming[HTTP_ATTR.METHOD],
        [HTTP_ATTR.ROUTE]: incoming[HTTP_ATTR.ROUTE] ?? ROUTE_UNMATCHED,
        [HTTP_ATTR.STATUS]: incoming[HTTP_ATTR.STATUS],
      }),
    },
  ],
};

function prometheusReader(port: number): MetricReader {
  // A port that cannot be bound stops the process: metrics were asked for and would be missing.
  return new PrometheusExporter({ host: METRICS_HOST, port, withoutScopeInfo: true }, (error) => {
    if (error) throw error;
  });
}

/**
 * Assembles the SDK from its parts (no `NodeSDK`, see ADR 0007 and 0008). Returns null and
 * registers nothing when metrics are off.
 */
export function startMetrics(
  env: Pick<Env, 'METRICS_ENABLED' | 'METRICS_PORT'>,
  options: { serviceName: ServiceName; reader?: MetricReader }
): MetricsHandle | null {
  if (!env.METRICS_ENABLED) return null;

  const provider = new MeterProvider({
    resource: resourceFromAttributes({ [RESOURCE_SERVICE_NAME]: options.serviceName }),
    readers: [options.reader ?? prometheusReader(env.METRICS_PORT)],
    views: [REQUEST_HISTOGRAM_VIEW],
  });
  metrics.setGlobalMeterProvider(provider);
  const releaseInstrumentation = acquireInstrumentation();
  useMeterProvider(provider);

  return {
    async shutdown() {
      releaseInstrumentation();
      await provider.shutdown();
      metrics.disable();
      useMeterProvider(metrics.getMeterProvider());
    },
  };
}
