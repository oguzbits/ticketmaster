import type { BusinessMetrics } from '../../../core/business-metrics.js';

/** A counting fake: every call is kept, in order, for the spec to look at. */
export class RecordingMetrics implements BusinessMetrics {
  private readonly recorded: { method: string; args: readonly (string | number)[] }[] = [];

  get calls(): readonly { method: string; args: readonly (string | number)[] }[] {
    return this.recorded;
  }

  holdAttempted(...args: Parameters<BusinessMetrics['holdAttempted']>): void {
    this.recorded.push({ method: 'holdAttempted', args });
  }

  bookingSettled(...args: Parameters<BusinessMetrics['bookingSettled']>): void {
    this.recorded.push({ method: 'bookingSettled', args: args.filter((a) => a !== undefined) });
  }

  effectProcessed(...args: Parameters<BusinessMetrics['effectProcessed']>): void {
    this.recorded.push({ method: 'effectProcessed', args });
  }

  cacheLookup(...args: Parameters<BusinessMetrics['cacheLookup']>): void {
    this.recorded.push({ method: 'cacheLookup', args });
  }
}
