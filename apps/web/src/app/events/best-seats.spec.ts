import { type Seat, SEAT_STATUS } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { pickBestAvailableSeats } from './best-seats';

function seat(
  id: string,
  section: string,
  row: number,
  number: number,
  priceCents: number,
  status: (typeof SEAT_STATUS)[keyof typeof SEAT_STATUS] = SEAT_STATUS.AVAILABLE
): Seat {
  return { id, section, row, number, priceCents, status };
}

describe('pickBestAvailableSeats', () => {
  it('picks contiguous seats in the same section and row, preferring lowest total price then row', () => {
    const seats = [
      seat('s1', 'A', 1, 1, 9000),
      seat('s2', 'A', 1, 2, 9000),
      seat('s3', 'B', 2, 1, 5000),
      seat('s4', 'B', 2, 2, 5000),
      seat('s5', 'B', 1, 1, 5000),
      seat('s6', 'B', 1, 2, 5000),
    ];

    const picked = pickBestAvailableSeats(seats, 2);

    expect(picked?.contiguous).toBe(true);
    expect(picked?.seats.map((s) => s.id)).toEqual(['s5', 's6']);
  });

  it('skips gaps from held or sold seats when finding a contiguous block', () => {
    const seats = [
      seat('s1', 'A', 1, 1, 5000),
      seat('s2', 'A', 1, 2, 5000, SEAT_STATUS.HELD),
      seat('s3', 'A', 1, 3, 5000),
      seat('s4', 'A', 1, 4, 5000),
    ];

    const picked = pickBestAvailableSeats(seats, 2);

    expect(picked?.contiguous).toBe(true);
    expect(picked?.seats.map((s) => s.id)).toEqual(['s3', 's4']);
  });

  it('falls back to the cheapest non-contiguous seats when no contiguous block exists', () => {
    const seats = [
      seat('s1', 'A', 1, 1, 9000),
      seat('s2', 'A', 1, 2, 9000, SEAT_STATUS.SOLD),
      seat('s3', 'A', 1, 3, 7000),
      seat('s4', 'B', 2, 5, 4000),
    ];

    const picked = pickBestAvailableSeats(seats, 2);

    expect(picked?.contiguous).toBe(false);
    expect(picked?.seats.map((s) => s.id)).toEqual(['s4', 's3']);
  });

  it('returns null when fewer than count seats are available or count is out of range', () => {
    const seats = [seat('s1', 'A', 1, 1, 5000)];

    expect(pickBestAvailableSeats(seats, 2)).toBeNull();
    expect(pickBestAvailableSeats(seats, 0)).toBeNull();
    expect(pickBestAvailableSeats(seats, 7)).toBeNull();
  });
});
