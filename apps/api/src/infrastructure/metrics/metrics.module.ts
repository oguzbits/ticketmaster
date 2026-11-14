import { Global, Module } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';

import { BUSINESS_METRICS } from '../../core/business-metrics.js';
import { OtelBusinessMetrics } from './otel-business-metrics.js';

const METER_NAME = 'ticketmaster-klon';

/** The meter is read when the app starts, after the preload registered the provider (or did not). */
@Global()
@Module({
  providers: [
    {
      provide: BUSINESS_METRICS,
      useFactory: () => new OtelBusinessMetrics(metrics.getMeter(METER_NAME)),
    },
  ],
  exports: [BUSINESS_METRICS],
})
export class MetricsModule {}
