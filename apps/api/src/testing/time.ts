// Holds written by the db specs must never fall due in real time: a worker of the Compose stack
// may share the database and expires every hold whose time has passed.
/** Clock of the specs that only need some time. */
export const SPEC_NOW = new Date('2200-01-01T12:00:00.000Z');
/**
 * Clock of the expiry spec. expireHolds works on the whole bookings table, so its calls (made with
 * times on this day) expire every hold due by then. No other spec may hold that early: they use
 * SPEC_NOW.
 */
export const EXPIRY_SPEC_START = new Date('2100-01-01T12:00:00.000Z');
/** End of the expiry spec's day: a hold that falls due later is out of reach of its sweeps. */
export const EXPIRY_SPEC_END = new Date(EXPIRY_SPEC_START.getTime() + 24 * 60 * 60 * 1000);
