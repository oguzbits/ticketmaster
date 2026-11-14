import type { Counter, Meter } from '@opentelemetry/api';

import type { BusinessMetrics } from '../../core/business-metrics.js';
import { METRIC, METRIC_ATTR } from './names.js';

/** The business counters on an OpenTelemetry meter; the no-op meter of a disabled SDK makes them no-ops. */
export class OtelBusinessMetrics implements BusinessMetrics {
  private readonly holds: Counter;
  private readonly settled: Counter;
  private readonly effects: Counter;

  constructor(meter: Meter) {
    this.holds = meter.createCounter(METRIC.HOLDS, { description: 'Hold attempts by outcome' });
    this.settled = meter.createCounter(METRIC.BOOKINGS_SETTLED, {
      description: 'Bookings that reached a final status',
    });
    this.effects = meter.createCounter(METRIC.QUEUE_EFFECTS, {
      description: 'Queue messages processed by effect and outcome',
    });
  }

  holdAttempted: BusinessMetrics['holdAttempted'] = (strategy, outcome) => {
    this.holds.add(1, { [METRIC_ATTR.STRATEGY]: strategy, [METRIC_ATTR.OUTCOME]: outcome });
  };

  bookingSettled: BusinessMetrics['bookingSettled'] = (status, count = 1) => {
    this.settled.add(count, { [METRIC_ATTR.STATUS]: status });
  };

  effectProcessed: BusinessMetrics['effectProcessed'] = (effect, outcome) => {
    this.effects.add(1, { [METRIC_ATTR.EFFECT]: effect, [METRIC_ATTR.OUTCOME]: outcome });
  };
}
