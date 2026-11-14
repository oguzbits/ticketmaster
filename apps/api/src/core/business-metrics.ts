import { type BookingStatus, type BookingStrategy, SIMULATION_STATUS } from '@app/shared';

import type { HoldOutcome } from './hold-outcome.js';

/** What the business counts. Adapters decide where the numbers go; the domain imports no telemetry. */
export interface BusinessMetrics {
  holdAttempted(strategy: BookingStrategy, outcome: HoldOutcome): void;
  /** Called after the commit that stored the status; `count` defaults to 1. */
  bookingSettled(status: BookingStatus, count?: number): void;
  effectProcessed(effect: string, outcome: EffectOutcome): void;
}

export const BUSINESS_METRICS = Symbol('BUSINESS_METRICS');

/** FAILED is the word the run status already declares: the magic-string audit knows each value once. */
export const EFFECT_OUTCOME = { SUCCEEDED: 'SUCCEEDED', FAILED: SIMULATION_STATUS.FAILED } as const;
export type EffectOutcome = (typeof EFFECT_OUTCOME)[keyof typeof EFFECT_OUTCOME];
