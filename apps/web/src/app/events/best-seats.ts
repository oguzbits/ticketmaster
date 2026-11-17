import { BOOKING_LIMITS, type Seat, SEAT_STATUS } from '@app/shared';

export interface BestSeatsResult {
  seats: Seat[];
  contiguous: boolean;
}

interface Candidate {
  seats: Seat[];
  totalCents: number;
  row: number;
  startNumber: number;
  section: string;
}

/**
 * Picks up to `count` available seats (`1..6`), preferring contiguous seats in the same section
 * and row ranked by lowest total price, lowest row, lowest starting seat number, and section.
 * Falls back to the lowest-priced non-contiguous available seats if no contiguous block exists,
 * or returns `null` if fewer than `count` available seats remain.
 */
export function pickBestAvailableSeats(
  seats: readonly Seat[],
  count: number
): BestSeatsResult | null {
  if (!isValidCount(count)) return null;
  const available = seats.filter((seat) => seat.status === SEAT_STATUS.AVAILABLE);
  if (available.length < count) return null;

  const contiguous = findBestContiguous(available, count);
  if (contiguous !== null) return { seats: contiguous.seats, contiguous: true };

  const cheapest = [...available].sort(compareSeats).slice(0, count);
  return { seats: cheapest, contiguous: false };
}

function isValidCount(count: number): boolean {
  return (
    Number.isInteger(count) &&
    count >= BOOKING_LIMITS.MIN_SEATS &&
    count <= BOOKING_LIMITS.MAX_SEATS
  );
}

function groupByRow(available: readonly Seat[]): Map<string, Seat[]> {
  const byRow = new Map<string, Seat[]>();
  for (const seat of available) {
    const key = `${seat.section}\0${seat.row}`;
    const list = byRow.get(key) ?? [];
    list.push(seat);
    byRow.set(key, list);
  }
  return byRow;
}

function findBestContiguous(available: readonly Seat[], count: number): Candidate | null {
  let best: Candidate | null = null;
  for (const rowSeats of groupByRow(available).values()) {
    rowSeats.sort((a, b) => a.number - b.number);
    best = pickBetterFromRow(rowSeats, count, best);
  }
  return best;
}

function pickBetterFromRow(
  rowSeats: readonly Seat[],
  count: number,
  currentBest: Candidate | null
): Candidate | null {
  let best = currentBest;
  for (let i = 0; i <= rowSeats.length - count; i += 1) {
    const windowSeats = rowSeats.slice(i, i + count);
    const first = windowSeats[0];
    if (!first || !areConsecutive(windowSeats)) continue;
    const candidate: Candidate = {
      seats: windowSeats,
      totalCents: windowSeats.reduce((sum, seat) => sum + seat.priceCents, 0),
      row: first.row,
      startNumber: first.number,
      section: first.section,
    };
    if (best === null || compareCandidate(candidate, best) < 0) best = candidate;
  }
  return best;
}

function areConsecutive(seats: readonly Seat[]): boolean {
  return seats.every((seat, i) => {
    const prev = seats[i - 1];
    return prev === undefined || seat.number === prev.number + 1;
  });
}

function compareSeats(a: Seat, b: Seat): number {
  return (
    a.priceCents - b.priceCents ||
    a.row - b.row ||
    a.number - b.number ||
    a.section.localeCompare(b.section)
  );
}

function compareCandidate(a: Candidate, b: Candidate): number {
  return (
    a.totalCents - b.totalCents ||
    a.row - b.row ||
    a.startNumber - b.startNumber ||
    a.section.localeCompare(b.section)
  );
}
