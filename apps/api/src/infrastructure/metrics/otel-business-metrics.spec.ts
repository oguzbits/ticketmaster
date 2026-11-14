import { BOOKING_STATUS, BOOKING_STRATEGY } from '@app/shared';
import { metrics } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EFFECT_OUTCOME } from '../../core/business-metrics.js';
import { HOLD_OUTCOME } from '../../core/hold-outcome.js';
import { METRIC, METRIC_ATTR } from './names.js';
import { OtelBusinessMetrics } from './otel-business-metrics.js';
import { dataPoints, startTestMetrics } from './testing/index.js';

const METER_NAME = 'otel-business-metrics-spec';
const QUEUE_EFFECT = 'ticket-pdf';

describe('OtelBusinessMetrics', () => {
  let started: ReturnType<typeof startTestMetrics>;
  let business: OtelBusinessMetrics;
  beforeEach(() => {
    started = startTestMetrics();
    business = new OtelBusinessMetrics(metrics.getMeter(METER_NAME));
  });
  afterEach(() => started.shutdown());

  it('counts a hold with exactly the strategy and outcome labels', async () => {
    business.holdAttempted(BOOKING_STRATEGY.OPTIMISTIC, HOLD_OUTCOME.SEAT_TAKEN);
    business.holdAttempted(BOOKING_STRATEGY.OPTIMISTIC, HOLD_OUTCOME.SEAT_TAKEN);

    const points = dataPoints(await started.collect(), METRIC.HOLDS);

    expect(points).toEqual([
      expect.objectContaining({
        value: 2,
        attributes: {
          [METRIC_ATTR.STRATEGY]: BOOKING_STRATEGY.OPTIMISTIC,
          [METRIC_ATTR.OUTCOME]: HOLD_OUTCOME.SEAT_TAKEN,
        },
      }),
    ]);
  });

  it('counts settled bookings by status only, one by default and n for a batch', async () => {
    business.bookingSettled(BOOKING_STATUS.CONFIRMED);
    business.bookingSettled(BOOKING_STATUS.EXPIRED, 3);

    const points = dataPoints(await started.collect(), METRIC.BOOKINGS_SETTLED);

    expect(points).toHaveLength(2);
    expect(points).toContainEqual(
      expect.objectContaining({
        value: 1,
        attributes: { [METRIC_ATTR.STATUS]: BOOKING_STATUS.CONFIRMED },
      })
    );
    expect(points).toContainEqual(
      expect.objectContaining({
        value: 3,
        attributes: { [METRIC_ATTR.STATUS]: BOOKING_STATUS.EXPIRED },
      })
    );
  });

  it('counts a processed queue effect with exactly the effect and outcome labels', async () => {
    business.effectProcessed(QUEUE_EFFECT, EFFECT_OUTCOME.FAILED);

    const points = dataPoints(await started.collect(), METRIC.QUEUE_EFFECTS);

    expect(points).toEqual([
      expect.objectContaining({
        value: 1,
        attributes: {
          [METRIC_ATTR.EFFECT]: QUEUE_EFFECT,
          [METRIC_ATTR.OUTCOME]: EFFECT_OUTCOME.FAILED,
        },
      }),
    ]);
  });
});
