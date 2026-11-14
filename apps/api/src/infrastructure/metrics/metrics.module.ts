import { Global, Module } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';

import { BUSINESS_METRICS } from '../../core/business-metrics.js';
import { METER_NAME } from './names.js';
import { OtelBusinessMetrics } from './otel-business-metrics.js';

/** The app's meter; read when the app starts, so the provider the preload registered is the one used. */
export const appMeter = () => metrics.getMeter(METER_NAME);

/** The meter is read when the app starts, after the preload registered the provider (or did not). */
@Global()
@Module({
  providers: [
    {
      provide: BUSINESS_METRICS,
      useFactory: () => new OtelBusinessMetrics(appMeter()),
    },
  ],
  exports: [BUSINESS_METRICS],
})
export class MetricsModule {}
