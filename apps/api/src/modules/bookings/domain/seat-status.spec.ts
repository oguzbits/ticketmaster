import type { BookingStatus, SeatStatus } from '@app/shared';
import { BOOKING_STATUS, SEAT_STATUS } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { ACTIVE_BOOKING_STATUSES, seatStatusOf } from './seat-status.js';

const CASES: readonly (readonly [BookingStatus | null, SeatStatus])[] = [
  [null, SEAT_STATUS.AVAILABLE],
  [BOOKING_STATUS.HELD, SEAT_STATUS.HELD],
  [BOOKING_STATUS.PAID, SEAT_STATUS.SOLD],
  [BOOKING_STATUS.CONFIRMED, SEAT_STATUS.SOLD],
  [BOOKING_STATUS.EXPIRED, SEAT_STATUS.AVAILABLE],
  [BOOKING_STATUS.CANCELLED, SEAT_STATUS.AVAILABLE],
];

describe('seatStatusOf', () => {
  it.each(CASES)('active booking %s -> seat %s', (status, expected) => {
    expect(seatStatusOf(status)).toBe(expected);
  });
});

describe('ACTIVE_BOOKING_STATUSES', () => {
  it('lists the statuses that occupy a seat', () => {
    expect([...ACTIVE_BOOKING_STATUSES].sort()).toEqual(
      [BOOKING_STATUS.HELD, BOOKING_STATUS.PAID, BOOKING_STATUS.CONFIRMED].sort()
    );
  });
});
