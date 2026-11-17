import { Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { claimTelemetryLifecycle, shutdownTelemetry } from './telemetry.js';

/**
 * Coordinates telemetry flush and shutdown with Nest's graceful shutdown lifecycle so trailing
 * spans from in-flight requests or queue jobs are exported before the providers close.
 */
@Module({})
export class TelemetryModule implements OnModuleInit, OnApplicationShutdown {
  onModuleInit(): void {
    claimTelemetryLifecycle();
  }

  onApplicationShutdown(): Promise<void> {
    return shutdownTelemetry();
  }
}
