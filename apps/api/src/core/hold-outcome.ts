export const HOLD_OUTCOME = {
  PLACED: 'PLACED',
  SEAT_TAKEN: 'SEAT_TAKEN',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
} as const;

export type HoldOutcome = (typeof HOLD_OUTCOME)[keyof typeof HOLD_OUTCOME];
