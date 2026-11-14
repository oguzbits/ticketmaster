import {
  type DataPoint,
  type ExponentialHistogram,
  type Histogram,
  MetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { register } from 'import-in-the-middle/register-hooks.mjs';

import { SERVICE_NAME } from '../../tracing/index.js';
import { scrapeTemporality, startMetrics } from '../metrics.js';

let hooksRegistered = false;

/**
 * What the tracing preload does before the app imports Express: without the ESM hooks the
 * instrumentations do not patch what the spec imports. Call it before the first start, once per file.
 */
export function registerEsmHooks(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  register();
}

/** A reader nobody polls: the spec collects when it wants to look. */
class CollectingReader extends MetricReader {
  constructor() {
    // The temporality of the real exporter: a gauge nobody observed is left out.
    super({ aggregationTemporalitySelector: scrapeTemporality });
  }

  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Registers the metrics SDK with a reader that opens no socket; call `shutdown` in `afterEach`. */
export function startTestMetrics(): {
  reader: MetricReader;
  collect: () => Promise<ResourceMetrics>;
  shutdown: () => Promise<void>;
} {
  const reader = new CollectingReader();
  const handle = startMetrics(
    { METRICS_ENABLED: true, METRICS_PORT: 9464, METRICS_HOST: '127.0.0.1' },
    { serviceName: SERVICE_NAME.API, reader }
  );
  if (!handle) throw new Error('metrics did not start');
  return {
    reader,
    async collect() {
      const result = await reader.collect();
      const [error] = result.errors;
      if (error) throw error;
      return result.resourceMetrics;
    },
    shutdown: () => handle.shutdown(),
  };
}

type AnyDataPoint = DataPoint<number> | DataPoint<Histogram> | DataPoint<ExponentialHistogram>;

/** The data points of one instrument, or none when it recorded nothing. */
export function dataPoints(resource: ResourceMetrics, name: string): AnyDataPoint[] {
  return resource.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric): AnyDataPoint[] => metric.dataPoints);
}

/** The number of observations behind one histogram data point. */
export function observationCount(point: AnyDataPoint): number {
  if (typeof point.value === 'number') throw new Error('not a histogram data point');
  return point.value.count;
}
