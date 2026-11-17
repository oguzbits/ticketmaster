export const ADMISSION_TOKENS = Symbol('ADMISSION_TOKENS');

export interface AdmissionTokenPayload {
  eventId: string;
  userId: string;
  admittedUntil: Date;
}

/**
 * Signs and verifies short-lived waiting-room admission tokens bound to `(eventId, userId)` and
 * expiring at `admittedUntil`.
 */
export interface AdmissionTokenPort {
  issue(payload: AdmissionTokenPayload, now: Date): Promise<string>;
  verify(token: string, expected: { eventId: string; userId: string }, now: Date): Promise<boolean>;
}
