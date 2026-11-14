import { metrics } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  InstrumentType,
  MeterProvider,
  type MetricReader,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics';

import type { Env } from '../../config/env.js';
import { acquireInstrumentation, type ServiceName, useMeterProvider } from '../tracing/index.js';
import { HTTP_ATTR, METER_NAME, METRIC, ROUTE_UNMATCHED } from './names.js';
import { subscribeQueryCounter } from './query-counter.js';

export interface MetricsHandle {
  shutdown(): Promise<void>;
}

const RESOURCE_SERVICE_NAME = 'service.name';

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

/** A port that cannot be bound stops the process: metrics were asked for and would be missing. */
export function failOnBindError(error: Error | void): void {
  if (error) throw error;
}

/**
 * Cumulative, as Prometheus needs for counters and histograms, except for observable gauges: a
 * cumulative reader repeats the last value of a gauge that nothing observed in this scrape, so a
 * failed callback would read as a stale but healthy value. As a delta, only what was observed
 * in this scrape is reported.
 */
export function scrapeTemporality(type: InstrumentType): AggregationTemporality {
  return type === InstrumentType.OBSERVABLE_GAUGE
    ? AggregationTemporality.DELTA
    : AggregationTemporality.CUMULATIVE;
}

/** The exporter fixes its temporality to cumulative; only this override can change it per instrument. */
class ScrapeExporter extends PrometheusExporter {
  override selectAggregationTemporality(type: InstrumentType): AggregationTemporality {
    return scrapeTemporality(type);
  }
}

function prometheusReader(host: string, port: number): MetricReader {
  return new ScrapeExporter({ host, port, withoutScopeInfo: true }, failOnBindError);
}

/**
 * Assembles the SDK from its parts (no `NodeSDK`, see ADR 0007 and 0008). Returns null and
 * registers nothing when metrics are off.
 */
export function startMetrics(
  env: Pick<Env, 'METRICS_ENABLED' | 'METRICS_PORT' | 'METRICS_HOST'>,
  options: { serviceName: ServiceName; reader?: MetricReader }
): MetricsHandle | null {
  if (!env.METRICS_ENABLED) return null;

  const provider = new MeterProvider({
    resource: resourceFromAttributes({ [RESOURCE_SERVICE_NAME]: options.serviceName }),
    readers: [options.reader ?? prometheusReader(env.METRICS_HOST, env.METRICS_PORT)],
    views: [REQUEST_HISTOGRAM_VIEW],
  });
  metrics.setGlobalMeterProvider(provider);
  const releaseInstrumentation = acquireInstrumentation();
  useMeterProvider(provider);
  // Not tied to tracing: the counter subscribes to the driver channel itself.
  const unsubscribeQueries = subscribeQueryCounter(provider.getMeter(METER_NAME));

  return {
    async shutdown() {
      unsubscribeQueries();
      releaseInstrumentation();
      await provider.shutdown();
      metrics.disable();
      useMeterProvider(metrics.getMeterProvider());
    },
  };
}
